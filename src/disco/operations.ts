/**
 * GraphQL operations for the Discovery & Context public schema (schema/disco.graphql).
 * Everything the server sends upstream is built here; test/schema-coverage.test.ts
 * checks these definitions against the SDL field by field.
 */

export const TAG_ENTRY_FIELDS = ['type', 'key', 'value'] as const;

const ENTITY_FIELDS = [
  'id',
  'originId',
  'name',
  'dataSourceType',
  'providerId',
  'providerType',
  'type',
  'subType',
  'description',
  'location',
  'tags',
  'additionalData',
  'managedByCyberArk',
  'originCreatedAt',
  'originUpdatedAt',
  'updatedAt',
] as const;

export const SECRET_FIELDS = [
  ...ENTITY_FIELDS,
  'username',
  'permanence',
  'compliance',
  'validityFrom',
  'validityTo',
  'originLastRetrieved',
] as const;

export const WORKLOAD_FIELDS = ENTITY_FIELDS;

export const AI_AGENT_FIELDS = [...ENTITY_FIELDS, 'instructions'] as const;

const ENTITY_SORT_FIELDS = [
  'id',
  'name',
  'originId',
  'providerId',
  'providerType',
  'type',
  'location',
  'originUpdatedAt',
  'originCreatedAt',
  'updatedAt',
] as const;

export const SECRET_SORT_FIELDS = [...ENTITY_SORT_FIELDS, 'validityFrom', 'validityTo', 'username'] as const;
export const WORKLOAD_SORT_FIELDS = ENTITY_SORT_FIELDS;
export const AI_AGENT_SORT_FIELDS = ENTITY_SORT_FIELDS;

/** Returned by add/replace mutations unless the caller asks for more. */
export const DEFAULT_MUTATION_FIELDS = ['id', 'originId', 'name', 'providerId', 'providerType'] as const;

export type EntityKind = 'secrets' | 'workloads' | 'aiAgents';

export interface EntitySpec {
  kind: EntityKind;
  /** Human-readable plural used in tool descriptions and messages. */
  label: string;
  typeName: string;
  fields: readonly string[];
  sortFields: readonly string[];
  query: { field: string; operationName: string; filterType: string; sortType: string };
  addReplace: {
    field: string;
    operationName: string;
    argName: string;
    inputType: string;
    itemsKey: string;
    totalKey: string;
  };
  delete: { field: string; operationName: string; filterType: string };
}

export const ENTITY_SPECS: Record<EntityKind, EntitySpec> = {
  secrets: {
    kind: 'secrets',
    label: 'secrets',
    typeName: 'Secret',
    fields: SECRET_FIELDS,
    sortFields: SECRET_SORT_FIELDS,
    query: { field: 'secrets', operationName: 'QuerySecrets', filterType: 'SecretsFilterInput', sortType: 'SecretsSortInput' },
    addReplace: {
      field: 'addReplaceExternalSecrets',
      operationName: 'AddReplaceExternalSecrets',
      argName: 'secrets',
      inputType: 'SecretInput',
      itemsKey: 'secrets',
      totalKey: 'totalProcessedSecrets',
    },
    delete: { field: 'deleteExternalSecrets', operationName: 'DeleteExternalSecrets', filterType: 'SecretsFilterInput' },
  },
  workloads: {
    kind: 'workloads',
    label: 'machine identities (workloads)',
    typeName: 'Workload',
    fields: WORKLOAD_FIELDS,
    sortFields: WORKLOAD_SORT_FIELDS,
    query: {
      field: 'workloads',
      operationName: 'QueryWorkloads',
      filterType: 'WorkloadsFilterInput',
      sortType: 'WorkloadsSortInput',
    },
    addReplace: {
      field: 'addReplaceExternalWorkloads',
      operationName: 'AddReplaceExternalWorkloads',
      argName: 'workloads',
      inputType: 'WorkloadInput',
      itemsKey: 'workloads',
      totalKey: 'totalProcessedWorkloads',
    },
    delete: {
      field: 'deleteExternalWorkloads',
      operationName: 'DeleteExternalWorkloads',
      filterType: 'WorkloadsFilterInput',
    },
  },
  aiAgents: {
    kind: 'aiAgents',
    label: 'AI agents',
    typeName: 'AiAgent',
    fields: AI_AGENT_FIELDS,
    sortFields: AI_AGENT_SORT_FIELDS,
    query: { field: 'aiAgents', operationName: 'QueryAiAgents', filterType: 'AiAgentsFilterInput', sortType: 'AiAgentsSortInput' },
    addReplace: {
      field: 'addReplaceExternalAiAgents',
      operationName: 'AddReplaceExternalAiAgents',
      argName: 'aiAgents',
      inputType: 'AiAgentInput',
      itemsKey: 'aiAgents',
      totalKey: 'totalProcessedAiAgents',
    },
    delete: {
      field: 'deleteExternalAiAgents',
      operationName: 'DeleteExternalAiAgents',
      filterType: 'AiAgentsFilterInput',
    },
  },
};

function selection(spec: EntitySpec, fields: readonly string[]): string {
  const unknown = fields.filter((field) => !spec.fields.includes(field));
  if (unknown.length > 0) throw new Error(`Unknown ${spec.typeName} field(s): ${unknown.join(', ')}`);
  if (fields.length === 0) throw new Error(`At least one ${spec.typeName} field must be selected`);
  return fields.map((field) => (field === 'tags' ? `tags { ${TAG_ENTRY_FIELDS.join(' ')} }` : field)).join(' ');
}

export function buildQueryDocument(spec: EntitySpec, fields: readonly string[] = spec.fields): string {
  const { field, operationName, filterType, sortType } = spec.query;
  return (
    `query ${operationName}($filter: ${filterType}, $pageInput: PageInput, $sort: [${sortType}]) { ` +
    `${field}(filter: $filter, pageInput: $pageInput, sort: $sort) { totalCount items { ${selection(spec, fields)} } } }`
  );
}

export function buildAddReplaceDocument(spec: EntitySpec, fields: readonly string[] = DEFAULT_MUTATION_FIELDS): string {
  const { field, operationName, argName, inputType, itemsKey, totalKey } = spec.addReplace;
  return (
    `mutation ${operationName}($${argName}: [${inputType}!]!) { ` +
    `${field}(${argName}: $${argName}) { ${totalKey} ${itemsKey} { ${selection(spec, fields)} } } }`
  );
}

export function buildDeleteDocument(spec: EntitySpec): string {
  const { field, operationName, filterType } = spec.delete;
  return `mutation ${operationName}($filter: ${filterType}!) { ${field}(filter: $filter) { totalDeleted } }`;
}
