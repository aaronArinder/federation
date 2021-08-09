import {
  assert,
  Field,
  FieldDefinition,
  FieldSelection,
  FragmentElement,
  FragmentSelection,
  InputType,
  isLeafType,
  isNullableType,
  Operation,
  Schema,
  SchemaRootKind,
  SelectableType,
  Selection,
  SelectionSet,
  VariableDefinitions
} from "@apollo/core";
import {
  Edge,
  federatedGraphRootTypeName,
  Graph,
  freeTransition,
  GraphPath,
  RootPath,
  advancePathWithTransition,
  Transition,
  OpGraphPath,
  advanceSimultaneousPathsWithOperation,
  ExcludedEdges
} from "@apollo/query-graphs";

export class ValidationError extends Error {
  constructor(
    message: string,
    readonly supergraphUnsatisfiablePath: RootPath<Transition>,
    readonly subgraphsPaths: RootPath<Transition>[],
    readonly witness: Operation
  ) {
    super(message);
  }
}

function validationError(unsatisfiablePath: RootPath<Transition>, subgraphsPaths: RootPath<Transition>[]): ValidationError {
  // TODO: build a proper error message. This probably needs to look the type of the last edge to adapt the message.
  const message = 'TODO';
  return new ValidationError(message, unsatisfiablePath, subgraphsPaths, buildWitnessOperation(unsatisfiablePath));
}

function buildWitnessOperation(witness: RootPath<Transition>): Operation {
  assert(witness.size > 0, "unsatisfiablePath should contain at least one edge/transition");
  const root = witness.root;
  return {
    rootKind: root.rootKind,
    selectionSet: buildWitnessNextStep([...witness.elements()].map(e => e[0]), 0)!,
    variableDefinitions: Object.create(null)
  };
}

function buildWitnessNextStep(edges: Edge[], index: number): SelectionSet | undefined  {
  if (index >= edges.length) {
    // We're at the end of our counter-example, meaning that we're at a point of traversing the supergraph where we know 
    // there is no valid equivalent subgraph traversals.
    // That said, we may well not be on a terminal vertex (the type may not be a leaf), meaning that returning 'undefined'
    // may be invalid.
    // In that case, we instead return an empty SelectionSet. This is, strictly speaking, equally invalid, but we use
    // this as a convention to means "there is supposed to be a selection but we don't have it" and the code
    // in `SelectionSet.toSelectionNode` handles this an prints an elipsis (a '...').
    //
    // Note that, as an alternative, we _could_ generate a random valid witness: while the current type is not terminal
    // we would randomly pick a valid choice (if it's an abstract type, we'd "cast" to any implementation; if it's an
    // object, we'd pick the first field and recurse on its type). However, while this would make sure our "witness"
    // is always a fully valid query, this is probably less user friendly in practice because you'd have to follow
    // the query manually to figure out at which point the query stop being satisfied by subgraphs. Putting the
    // elipsis instead make it immediately clear after which part of the query there is an issue.
    const lastType = edges[edges.length -1].tail.type;
    // Note that vertex types are named type and output ones, so if it's not a leaf it is guaranteed to be selectable.
    return isLeafType(lastType) ? undefined : new SelectionSet(lastType as SelectableType);
  }

  const edge = edges[index];
  let selection: Selection;
  const subSelection = buildWitnessNextStep(edges, index + 1);
  switch (edge.transition.kind) {
    case 'DownCast':
      const type = edge.transition.castedType;
      selection = new FragmentSelection(
        new FragmentElement(edge.transition.sourceType, type.name),
        subSelection!
      );
      break;
    case 'FieldCollection':
      const field = edge.transition.definition;
      selection = new FieldSelection(buildWitnessField(field), subSelection);
      break
    case 'FreeTransition':
    case 'KeyResolution':
      return subSelection;
  }
  // If we get here, the edge is either a downcast or a field, so the edge head must be selectable.
  const selectionSet = new SelectionSet(edge.head.type as SelectableType);
  selectionSet.add(selection);
  return selectionSet;
}

function buildWitnessField(definition: FieldDefinition<any>): Field {
  const args = Object.create(null);
  for (const argDef of definition.arguments()) {
    args[argDef.name] = generateWitnessValue(argDef.type!);
  }
  return new Field(definition, args, new VariableDefinitions());
}

function generateWitnessValue(type: InputType): any {
  switch (type.kind) {
    case 'ScalarType':
      switch (type.name) {
        case 'Int':
          return 0;
        case 'Float':
          return 3.14;
        case 'Boolean':
          return true;
        case 'String':
          return 'A string value';
        case 'ID':
          // Users probably expect a particular format of ID at any particular place, but we have zero info on
          // the context, so we just throw a string that hopefully make things clear.
          return '<any id>';
        default:
          // It's a custom scalar, but we don't know anything about that scalar so providing some random string. This
          // will technically probably not be a valid value for that scalar, but hopefully that won't be enough to
          // throw users off.
          return '<some value>';
      }
    case 'EnumType':
      return type.values[0].name;
    case 'InputObjectType':
      const obj = Object.create(null);
      for (const field of type.fields.values()) {
        // We don't bother with non-mandatory fields.
        if (field.defaultValue || isNullableType(field.type!)) {
          continue;
        }
        obj[field.name] = generateWitnessValue(field.type!);
      }
      return obj;
    case 'ListType':
      return [];
    case 'NonNullType':
      // None of our generated witness values are null so...
      return generateWitnessValue(type.ofType);
    default:
      assert(false, `Unhandled input type ${type}`);
  }
}

export function validateGraphComposition(supergraph: Graph, subgraphs: Graph): {error? : ValidationError} {
  try {
    new ValidationTaversal(supergraph, subgraphs).validate();
    return {};
  } catch (e) {
    if (e instanceof ValidationError) {
      return {error: e};
    }
    throw e;
  }
}

export function computeSubgraphPaths(supergraphPath: RootPath<Transition>, subgraphs: Graph): {traversal?: ValidationState, error?: ValidationError} {
  try {
    assert(!supergraphPath.hasAnyEdgeConditions(), `A supergraph path should not have edge condition paths (as supergraph edges should not have conditions): ${supergraphPath}`);
    const supergraphSchema = [...supergraphPath.graph.sources.values()][0];
    let initialState = ValidationState.initial(supergraphPath.graph, supergraphPath.root.rootKind, subgraphs);
    const traversal = supergraphPath.reduceMainPath((state, edge) => state.validateTransition(supergraphSchema, edge), initialState);
    return {traversal};
  } catch (error) {
    if (error instanceof ValidationError) {
      return {error};
    }
    throw error;
  }
}

function initialSubgraphPaths(kind: SchemaRootKind, subgraphs: Graph): RootPath<Transition>[] {
  const root = subgraphs.root(kind);
  assert(root, `The supergraph shouldn't have a ${kind} root if no subgraphs have one`);
  assert(
    root.type.name == federatedGraphRootTypeName(kind),
    `Unexpected type ${root.type} for subgraphs root type (expected ${federatedGraphRootTypeName(kind)}`);
  const initialState = GraphPath.fromGraphRoot<Transition>(subgraphs, kind)!;
  return subgraphs.outEdges(root).map(e => initialState.add(freeTransition, e));
}

export class ValidationState {
  constructor(
    // Path in the supergraph corresponding to the current state.
    public readonly supergraphPath: RootPath<Transition>,
    // All the possible paths we could be in the subgraph.
    public readonly subgraphPaths: RootPath<Transition>[]
  ) {
    assert(
      subgraphPaths.every(p => p.tail.type.name == this.supergraphPath.tail.type.name),
      `Invalid state ${this}: some subgraphs type don't match the supergraph.`);
  }

  static initial(supergraph: Graph, kind: SchemaRootKind, subgraphs: Graph) {
    return new ValidationState(GraphPath.fromGraphRoot(supergraph, kind)!, initialSubgraphPaths(kind, subgraphs));
  }

  // Either throw or return a new state.
  validateTransition(supergraphSchema: Schema, supergraphEdge: Edge): ValidationState {
    assert(!supergraphEdge.conditions, `Supergraph edges should not have conditions (${supergraphEdge})`);

    const transition = supergraphEdge.transition;
    const targetType = supergraphEdge.tail.type;
    const newSubgraphPaths = this.subgraphPaths.flatMap(path => advancePathWithTransition(
      path,
      transition,
      targetType,
      (conditions, vertex, excluded) => validateConditions(supergraphSchema, conditions, GraphPath.create(path.graph, vertex), excluded)
    ));
    const newPath = this.supergraphPath.add(transition, supergraphEdge);
    if (newSubgraphPaths.length == 0) {
      throw validationError(newPath, this.subgraphPaths);
    }
    return new ValidationState(newPath, newSubgraphPaths);
  }

  hasCycled(): boolean {
    // A state is a configuration that points to a particular type/vertex in the supergraph and to
    // a number of subgraph vertex _for the same type_. So if any of the subgraph state is such that
    // the current vertex (in the subgraph) has already been visited, then we've cycled (in a particular
    // subgraph, but that also imply in the supergraph).
    return this.subgraphPaths.some(p => p.hasJustCycled());
  }

  toString(): string {
    return `${this.supergraphPath} <=> [${this.subgraphPaths.map(s => s.toString()).join(', ')}]`;
  }
}

class ValidationTaversal {
  private readonly supergraphSchema: Schema;
  // The stack contains all states that aren't terminal.
  private readonly stack: ValidationState[] = [];

  constructor(supergraph: Graph, subgraphs: Graph) {
    this.supergraphSchema = [...supergraph.sources.values()][0];
    supergraph.rootKinds().forEach(k => this.stack.push(ValidationState.initial(supergraph, k, subgraphs)));
  }

  //private dumpStack(message?: string) {
  //  if (message) console.log(message);
  //  for (const state of this.stack) {
  //    console.log(` - ${state}`);
  //  }
  //}

  validate() {
    while (this.stack.length > 0) {
      //this.dumpStack("Current State:");
      this.handleState(this.stack.pop()!);
    }
  }

  private handleState(state: ValidationState) {
    // Note that if supergraphVertex is terminal, this method is a no-op, which is expected/desired as
    // it means we've successfully "validate" a path to its end.
    for (const edge of state.supergraphPath.nextEdges()) {
      const newState = state.validateTransition(this.supergraphSchema, edge);
      // The check for `isTerminal` is not strictly necessary as if we add a terminal
      // state to the stack this method, `handleState`, will do nothing later. But it's
      // worth checking it now and save some memory/cycles.
      if (!newState.supergraphPath.isTerminal() && !newState.hasCycled()) {
        this.stack.push(newState);
      }
    }
  }
}


class ConditionValidationState {
  constructor(
    // Selection that belongs to the condition we're validating.
    readonly selection: Selection,
    // All the possible "simultaneous paths" we could be in the subgraph when we reach this state selection.
    readonly subgraphPaths: OpGraphPath[][]
  ) {}

  validateCurrentSelection(supergraphSchema: Schema, excludedEdges: ExcludedEdges): ConditionValidationState[] | null {
    const newPaths = this.subgraphPaths.flatMap(path => advanceSimultaneousPathsWithOperation(
      supergraphSchema,
      path,
      this.selection.element(),
      (conditions, vertex, excluded) => validateConditions(supergraphSchema, conditions, GraphPath.create(path[0].graph, vertex), excluded),
      excludedEdges)
    );

    // If we got no paths, it means that particular selection of the conditions cannot be satisfied, so the
    // overall condition cannot.
    if (newPaths.length === 0) {
      return null;
    }

    return this.selection.selectionSet
      ? [...this.selection.selectionSet.selections()].map(s => new ConditionValidationState(s, newPaths))
      : [];
  }

  toString(): string {
    return `${this.selection} <=> [${this.subgraphPaths.map(s => s.toString()).join(', ')}]`;
  }
}

function validateConditions(supergraphSchema: Schema, conditions: SelectionSet, initialPath: OpGraphPath, excludedEdges: ExcludedEdges): null | undefined {
  const stack: ConditionValidationState[] = [];
  for (const selection of conditions.selections()) {
    stack.push(new ConditionValidationState(selection, [[initialPath]]));
  }

  while (stack.length > 0) {
    const state = stack.pop()!;
    const newStates = state.validateCurrentSelection(supergraphSchema, excludedEdges);
    if (newStates === null) {
      return null;
    }
    newStates.forEach(s => stack.push(s));
  }
  // If we exhaust the stack, it means we've been able to find "some" path for every possible selection in the condition, so the
  // condition is validated.
  return undefined;
}

