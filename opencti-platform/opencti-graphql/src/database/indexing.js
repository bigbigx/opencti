import { flatten, map, pipe, uniqBy } from 'ramda';
import { Promise } from 'bluebird';
import moment from 'moment';
import { find, getSingleValueNumber } from './grakn';
import { DATA_INDICES, elCreateIndexes, elDeleteIndexes, elIndexElements } from './elasticSearch';
import { logger } from '../config/conf';
import {
  ABSTRACT_INTERNAL_OBJECT,
  ABSTRACT_INTERNAL_RELATIONSHIP,
  ABSTRACT_STIX_CYBER_OBSERVABLE,
  ABSTRACT_STIX_CYBER_OBSERVABLE_RELATIONSHIP,
  ABSTRACT_STIX_DOMAIN_OBJECT,
  ABSTRACT_STIX_META_OBJECT,
  ABSTRACT_STIX_META_RELATIONSHIP,
  ABSTRACT_STIX_RELATIONSHIP,
} from '../schema/general';
import { RELATION_MEMBER_OF } from '../schema/internalRelationship';
import { STIX_SIGHTING_RELATIONSHIP } from '../schema/stixSightingRelationship';

const GROUP_NUMBER = 200; // Pagination size for query
const GROUP_CONCURRENCY = 10; // Number of query in //
const GROUP_INDEX_MAX_RETRY = 5; // Number of index update retry (Useful for relations impacts update)

// eslint-disable-next-line no-extend-native
const pad = (val, size) => {
  let s = String(val);
  while (s.length < (size || 2)) {
    s = `0${s}`;
  }
  return s;
};

const indexElement = async (type, isRelation = false, fromType = null, toType = null) => {
  const start = moment();
  // Indexing all entities
  const matchingQuery = isRelation ? '$rel($from, $to)' : '$elem';
  let typeSuffix = fromType ? `$from isa ${fromType};` : '';
  typeSuffix += toType ? `$to isa ${toType};` : '';

  const nbOfEntities = await getSingleValueNumber(`match ${matchingQuery} isa ${type}; ${typeSuffix} get; count;`);
  if (nbOfEntities === 0) return;
  // Compute the number of groups to create
  let counter = 0;
  const nbGroup = Math.ceil(nbOfEntities / GROUP_NUMBER);
  const count = isRelation ? nbOfEntities / 2 : nbOfEntities;
  process.stdout.write(`Indexing ${count} ${type} in 000/${pad(nbGroup, 3)} batchs\r`);
  // Build queries to execute
  const queries = [];
  for (let index = 0; index < nbGroup; index += 1) {
    const offset = index * GROUP_NUMBER;
    const query = `match ${matchingQuery} isa ${type}; ${typeSuffix} get; offset ${offset}; limit ${GROUP_NUMBER};`;
    queries.push(query);
  }
  // Fetch grakn with concurrency limit.
  await Promise.map(
    queries,
    (query) => {
      return find(query, [isRelation ? 'rel' : 'elem'], { noCache: true })
        .then((fetchedGroupElements) => {
          const fetchedElements = pipe(
            flatten,
            map((e) => e[isRelation ? 'rel' : 'elem']),
            uniqBy((u) => u.grakn_id)
          )(fetchedGroupElements);
          return elIndexElements(fetchedElements, GROUP_INDEX_MAX_RETRY);
        })
        .then(() => {
          counter += 1;
          process.stdout.write(`Indexing ${count} ${type} in ${pad(counter, 3)}/${pad(nbGroup, 3)} batchs\r`);
        });
    },
    { concurrency: GROUP_CONCURRENCY }
  );
  const execDuration = moment.duration(moment().diff(start));
  const avg = (execDuration.asSeconds() / count).toFixed(2);
  logger.info(
    `Indexing of ${type} done in ${execDuration.asSeconds()} secs (${execDuration.humanize()}) - Element Avg: ${avg} secs`
  );
  logger.info(`> ---------------------------------------------------------------------`);
};

const index = async () => {
  // 01. Delete current indexes
  await elDeleteIndexes(DATA_INDICES);
  logger.info(`[INDEX] Old indices deleted`);
  // 02. Create new ones
  await elCreateIndexes();
  logger.info(`[INDEX] New indices created`);
  // 03. Handle every entity subbing entity
  // MigrationsStatus  - Not needed, migration related.
  // MigrationReference  - Not needed, migration related.
  // Token - Not needed, authentication
  await indexElement(ABSTRACT_INTERNAL_OBJECT);
  await indexElement(ABSTRACT_STIX_DOMAIN_OBJECT);
  await indexElement(ABSTRACT_STIX_META_OBJECT);
  await indexElement(ABSTRACT_STIX_CYBER_OBSERVABLE);

  // 04. Handle every entity subbing relation
  // migrate - Not needed, migration related.
  // authorize - Not needed, authentication
  await indexElement(RELATION_MEMBER_OF, true);
  await indexElement(ABSTRACT_STIX_RELATIONSHIP, true, 'entity', 'entity');
  await indexElement(ABSTRACT_STIX_RELATIONSHIP, true, 'entity', 'relation');
  await indexElement(ABSTRACT_STIX_RELATIONSHIP, true, 'relation', 'relation');
  await indexElement(ABSTRACT_STIX_CYBER_OBSERVABLE_RELATIONSHIP, true);
  await indexElement(ABSTRACT_STIX_META_RELATIONSHIP, true);
  await indexElement(ABSTRACT_INTERNAL_RELATIONSHIP, true);
  await indexElement(STIX_SIGHTING_RELATIONSHIP, true);
};

export default index;
