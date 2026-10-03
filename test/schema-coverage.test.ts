/**
 * Proves the server covers 100% of the documented Discovery & Context GraphQL schema
 * (schema/disco.graphql, extracted verbatim from the Idira docs): every root field has a
 * tool, every input field is accepted, every output field is selectable, every enum value
 * is known. Each comparison is exact in both directions, so the server can neither miss a
 * documented field nor invent one.
 */
import {
  type GraphQLEnumType,
  type GraphQLInputObjectType,
  type GraphQLInterfaceType,
  type GraphQLObjectType,
  isNonNullType,
  parse,
  validate,
} from 'graphql';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  buildAddReplaceDocument,
  buildDeleteDocument,
  buildQueryDocument,
  ENTITY_SPECS,
  type EntityKind,
  TAG_ENTRY_FIELDS,
} from '../src/disco/operations.js';
import { TOOL_OPERATIONS } from '../src/tools/register.js';
import * as schemas from '../src/tools/schemas.js';
import { buildDiscoSchema } from './helpers/mockIdira.js';

const schema = buildDiscoSchema();
const KINDS = Object.keys(ENTITY_SPECS) as EntityKind[];

const zodByKind = {
  secrets: { input: schemas.secretInput, filter: schemas.secretsFilter, sort: schemas.secretsSort },
  workloads: { input: schemas.workloadInput, filter: schemas.workloadsFilter, sort: schemas.workloadsSort },
  aiAgents: { input: schemas.aiAgentInput, filter: schemas.aiAgentsFilter, sort: schemas.aiAgentsSort },
};

function objectFields(typeName: string): string[] {
  return Object.keys((schema.getType(typeName) as GraphQLObjectType | GraphQLInterfaceType).getFields()).sort();
}

function inputFields(typeName: string): { all: string[]; required: string[] } {
  const fields = (schema.getType(typeName) as GraphQLInputObjectType).getFields();
  return {
    all: Object.keys(fields).sort(),
    required: Object.keys(fields)
      .filter((name) => isNonNullType(fields[name]!.type))
      .sort(),
  };
}

function enumValues(typeName: string): string[] {
  return (schema.getType(typeName) as GraphQLEnumType)
    .getValues()
    .map((value) => value.name)
    .sort();
}

interface JsonSchema {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: string[];
}

/** JSON Schema of a zod schema as a tool input, with a top-level $ref resolved. */
function jsonSchema(zodSchema: z.ZodType): JsonSchema {
  const root = z.toJSONSchema(zodSchema, { io: 'input' }) as JsonSchema;
  return root.$ref ? root.$defs![root.$ref.replace('#/$defs/', '')]! : root;
}

function zodFields(zodSchema: z.ZodType): { all: string[]; required: string[] } {
  const json = jsonSchema(zodSchema);
  return { all: Object.keys(json.properties ?? {}).sort(), required: [...(json.required ?? [])].sort() };
}

const sorted = (values: readonly string[]) => [...values].sort();

describe('root operations', () => {
  it('has exactly one tool for every Query and Mutation field', () => {
    const documented = [...objectFields('Query'), ...objectFields('Mutation')].sort();
    expect(sorted(TOOL_OPERATIONS.map((tool) => tool.graphqlField))).toEqual(documented);
    expect(documented).toHaveLength(9);
  });

  it('maps query tools to Query fields and mutating tools to Mutation fields', () => {
    for (const tool of TOOL_OPERATIONS) {
      const root = tool.action === 'query' ? 'Query' : 'Mutation';
      expect(objectFields(root), tool.name).toContain(tool.graphqlField);
    }
  });

  it('gives every tool a unique disco_-prefixed name', () => {
    const names = TOOL_OPERATIONS.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^disco_(query|add_replace|delete)_(secrets|workloads|ai_agents)$/);
  });
});

describe.each(KINDS)('%s operations', (kind) => {
  const spec = ENTITY_SPECS[kind];
  const zod = zodByKind[kind];

  it('sends documents that validate against the documented schema', () => {
    const documents = [buildQueryDocument(spec), buildAddReplaceDocument(spec, spec.fields), buildDeleteDocument(spec)];
    for (const document of documents) expect(validate(schema, parse(document)), document).toEqual([]);
  });

  it('selects every output field of the entity type', () => {
    expect(sorted(spec.fields)).toEqual(objectFields(spec.typeName));
    const pageType = schema.getQueryType()!.getFields()[spec.query.field]!.type.toString().replace('!', '');
    expect(objectFields(pageType)).toEqual(['items', 'totalCount']);
  });

  it('reads every field of the mutation responses', () => {
    const mutations = schema.getMutationType()!.getFields();
    const addType = mutations[spec.addReplace.field]!.type.toString().replace('!', '');
    expect(objectFields(addType)).toEqual(sorted([spec.addReplace.itemsKey, spec.addReplace.totalKey]));
    const deleteType = mutations[spec.delete.field]!.type.toString().replace('!', '');
    expect(objectFields(deleteType)).toEqual(['totalDeleted']);
  });

  it('accepts every field of the entity input type, with the same required set', () => {
    expect(zodFields(zod.input)).toEqual(inputFields(spec.addReplace.inputType));
  });

  it('accepts every field of the filter input type, including and/or/not', () => {
    expect(zodFields(zod.filter).all).toEqual(inputFields(spec.query.filterType).all);
    expect(spec.delete.filterType).toBe(spec.query.filterType);
  });

  it('can sort by every field of the sort input type', () => {
    expect(sorted(jsonSchema(zod.sort).items!.properties!.field!.enum!)).toEqual(inputFields(spec.query.sortType).all);
    expect(sorted(spec.sortFields)).toEqual(inputFields(spec.query.sortType).all);
  });

  it('uses the argument names and types the schema declares', () => {
    const queryArgs = schema.getQueryType()!.getFields()[spec.query.field]!.args;
    expect(Object.fromEntries(queryArgs.map((arg) => [arg.name, arg.type.toString()]))).toEqual({
      filter: spec.query.filterType,
      pageInput: 'PageInput',
      sort: `[${spec.query.sortType}]`,
    });
    const mutations = schema.getMutationType()!.getFields();
    expect(mutations[spec.addReplace.field]!.args.map((arg) => [arg.name, arg.type.toString()])).toEqual([
      [spec.addReplace.argName, `[${spec.addReplace.inputType}!]!`],
    ]);
    expect(mutations[spec.delete.field]!.args.map((arg) => [arg.name, arg.type.toString()])).toEqual([
      ['filter', `${spec.delete.filterType}!`],
    ]);
  });
});

describe('shared input types', () => {
  it('TagEntryInput and TagEntry', () => {
    expect(zodFields(schemas.tagEntryInput)).toEqual(inputFields('TagEntryInput'));
    expect(sorted(TAG_ENTRY_FIELDS)).toEqual(objectFields('TagEntry'));
  });

  it('PageInput', () => {
    expect(zodFields(z.object(schemas.pageShape)).all).toEqual(inputFields('PageInput').all);
  });

  it('leaf filter types', () => {
    expect(zodFields(schemas.stringEqualsFilter).all).toEqual(inputFields('StringEqualsFilter').all);
    expect(zodFields(schemas.stringContainsFilter).all).toEqual(inputFields('StringContainsFilter').all);
    expect(zodFields(schemas.dateFilter).all).toEqual(inputFields('DateFilter').all);
    expect(zodFields(schemas.dataSourceTypeFilter).all).toEqual(inputFields('DataSourceTypeFilter').all);
  });

  it('uses the leaf filter type the schema declares for every filter field', () => {
    const leafByType: Record<string, string[]> = {
      StringEqualsFilter: ['eq'],
      StringContainsFilter: ['contains'],
      DateFilter: ['gt', 'lt'],
      DataSourceTypeFilter: ['eq'],
    };
    for (const kind of KINDS) {
      const filterType = schema.getType(ENTITY_SPECS[kind].query.filterType) as GraphQLInputObjectType;
      const properties = jsonSchema(zodByKind[kind].filter).properties!;
      for (const [name, field] of Object.entries(filterType.getFields())) {
        const expected = leafByType[field.type.toString()];
        if (!expected) continue; // and / or / not
        expect(Object.keys(properties[name]!.properties!).sort(), `${kind}.${name}`).toEqual(expected);
      }
      expect(properties.dataSourceType!.properties!.eq!.enum!.sort()).toEqual(enumValues('DataSourceType'));
    }
  });
});

describe('enums', () => {
  it.each([
    ['TagType', schemas.TAG_TYPES],
    ['SecretPermanence', schemas.SECRET_PERMANENCE],
    ['DataSourceType', schemas.DATA_SOURCE_TYPES],
    ['SortOrder', schemas.SORT_ORDERS],
  ] as const)('%s', (typeName, values) => {
    expect(sorted(values)).toEqual(enumValues(typeName));
  });
});

describe('whole schema', () => {
  it('contains no type this suite does not account for', () => {
    const accounted = new Set([
      'Query',
      'Mutation',
      'AWSDateTime',
      'AWSJSON',
      'String',
      'Int',
      'Boolean',
      'TagType',
      'SecretPermanence',
      'DataSourceType',
      'SortOrder',
      'TagEntryInput',
      'TagEntry',
      'PageInput',
      'StringEqualsFilter',
      'StringContainsFilter',
      'DateFilter',
      'DataSourceTypeFilter',
      'Entity',
      'DeleteSecretsResponse',
      'DeleteResponse',
      ...KINDS.flatMap((kind) => {
        const spec = ENTITY_SPECS[kind];
        const fields = { ...schema.getQueryType()!.getFields(), ...schema.getMutationType()!.getFields() };
        return [
          spec.typeName,
          spec.addReplace.inputType,
          spec.query.filterType,
          spec.query.sortType,
          fields[spec.query.field]!.type.toString().replace('!', ''),
          fields[spec.addReplace.field]!.type.toString().replace('!', ''),
        ];
      }),
    ]);
    const documented = Object.keys(schema.getTypeMap()).filter((name) => !name.startsWith('__'));
    expect(documented.filter((name) => !accounted.has(name))).toEqual([]);
  });

  it('selects every field of the Entity interface on every implementing type', () => {
    for (const kind of KINDS) {
      for (const field of objectFields('Entity')) expect(ENTITY_SPECS[kind].fields, `${kind}.${field}`).toContain(field);
    }
  });
});

describe('document builders', () => {
  it('refuse fields the entity type does not have, and empty selections', () => {
    expect(() => buildQueryDocument(ENTITY_SPECS.workloads, ['name', 'instructions'])).toThrow('Unknown Workload field(s): instructions');
    expect(() => buildAddReplaceDocument(ENTITY_SPECS.secrets, [])).toThrow('At least one Secret field must be selected');
  });
});
