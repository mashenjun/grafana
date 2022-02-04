// Libraries
import { omit } from 'lodash';

// Services & Utils
import { DataQuery, DataSourceApi, dateTimeFormat, ExploreUrlState, urlUtil } from '@grafana/data';
import { dispatch } from 'app/store/store';
import { notifyApp } from 'app/core/actions';
import { createErrorNotification, createWarningNotification } from 'app/core/copy/appNotification';

// Types
import { RichHistoryQuery } from 'app/types/explore';
import { serializeStateToUrlParam } from '@grafana/data/src/utils/url';
import { getDataSourceSrv } from '@grafana/runtime';
import { getRichHistoryStorage } from '../history/richHistoryStorageProvider';
import {
  RichHistoryServiceError,
  RichHistoryStorageWarning,
  RichHistoryStorageWarningDetails,
} from '../history/RichHistoryStorage';
import {
  filterQueriesByDataSource,
  filterQueriesBySearchFilter,
  filterQueriesByTime,
  sortQueries,
} from 'app/core/history/richHistoryLocalStorageUtils';
import { SortOrder } from './richHistoryTypes';

export { SortOrder };

/*
 * Add queries to rich history. Save only queries within the retention period, or that are starred.
 * Side-effect: store history in local storage
 */

export async function addToRichHistory(
  richHistory: RichHistoryQuery[],
  datasourceId: string,
  datasourceName: string | null,
  queries: DataQuery[],
  starred: boolean,
  comment: string | null,
  sessionName: string,
  showQuotaExceededError: boolean,
  showLimitExceededWarning: boolean
): Promise<{ richHistory: RichHistoryQuery[]; richHistoryStorageFull?: boolean; limitExceeded?: boolean }> {
  const ts = Date.now();
  /* Save only queries, that are not falsy (e.g. empty object, null, ...) */
  const newQueriesToSave: DataQuery[] = queries && queries.filter((query) => notEmptyQuery(query));

  if (newQueriesToSave.length > 0) {
    const newRichHistory: RichHistoryQuery = {
      queries: newQueriesToSave,
      ts,
      datasourceId,
      datasourceName: datasourceName ?? '',
      starred,
      comment: comment ?? '',
      sessionName,
    };

    let richHistoryStorageFull = false;
    let limitExceeded = false;
    let warning: RichHistoryStorageWarningDetails | undefined;

    try {
      warning = await getRichHistoryStorage().addToRichHistory(newRichHistory);
    } catch (error) {
      if (error.name === RichHistoryServiceError.StorageFull) {
        richHistoryStorageFull = true;
        showQuotaExceededError && dispatch(notifyApp(createErrorNotification(error.message)));
      } else if (error.name !== RichHistoryServiceError.DuplicatedEntry) {
        dispatch(notifyApp(createErrorNotification('Rich History update failed', error.message)));
      }
      // Saving failed. Do not add new entry.
      return { richHistory, richHistoryStorageFull, limitExceeded };
    }

    // Limit exceeded but new entry was added. Notify that old entries have been removed.
    if (warning && warning.type === RichHistoryStorageWarning.LimitExceeded) {
      limitExceeded = true;
      showLimitExceededWarning && dispatch(notifyApp(createWarningNotification(warning.message)));
    }

    // Saving successful - add new entry.
    return { richHistory: [newRichHistory, ...richHistory], richHistoryStorageFull, limitExceeded };
  }

  // Nothing to save
  return { richHistory };
}

export async function getRichHistory(): Promise<RichHistoryQuery[]> {
  return await getRichHistoryStorage().getRichHistory();
}

export async function deleteAllFromRichHistory(): Promise<void> {
  return getRichHistoryStorage().deleteAll();
}

export async function updateStarredInRichHistory(richHistory: RichHistoryQuery[], ts: number) {
  let updatedQuery: RichHistoryQuery | undefined;

  const updatedHistory = richHistory.map((query) => {
    /* Timestamps are currently unique - we can use them to identify specific queries */
    if (query.ts === ts) {
      const isStarred = query.starred;
      updatedQuery = Object.assign({}, query, { starred: !isStarred });
      return updatedQuery;
    }
    return query;
  });

  if (!updatedQuery) {
    return richHistory;
  }

  try {
    await getRichHistoryStorage().updateStarred(ts, updatedQuery.starred);
    return updatedHistory;
  } catch (error) {
    dispatch(notifyApp(createErrorNotification('Saving rich history failed', error.message)));
    return richHistory;
  }
}

export async function updateCommentInRichHistory(
  richHistory: RichHistoryQuery[],
  ts: number,
  newComment: string | undefined
) {
  let updatedQuery: RichHistoryQuery | undefined;
  const updatedHistory = richHistory.map((query) => {
    if (query.ts === ts) {
      updatedQuery = Object.assign({}, query, { comment: newComment });
      return updatedQuery;
    }
    return query;
  });

  if (!updatedQuery) {
    return richHistory;
  }

  try {
    await getRichHistoryStorage().updateComment(ts, newComment);
    return updatedHistory;
  } catch (error) {
    dispatch(notifyApp(createErrorNotification('Saving rich history failed', error.message)));
    return richHistory;
  }
}

export async function deleteQueryInRichHistory(
  richHistory: RichHistoryQuery[],
  ts: number
): Promise<RichHistoryQuery[]> {
  const updatedHistory = richHistory.filter((query) => query.ts !== ts);
  try {
    await getRichHistoryStorage().deleteRichHistory(ts);
    return updatedHistory;
  } catch (error) {
    dispatch(notifyApp(createErrorNotification('Saving rich history failed', error.message)));
    return richHistory;
  }
}

export function filterAndSortQueries(
  queries: RichHistoryQuery[],
  sortOrder: SortOrder,
  listOfDatasourceFilters: string[],
  searchFilter: string,
  timeFilter?: [number, number]
) {
  const filteredQueriesByDs = filterQueriesByDataSource(queries, listOfDatasourceFilters);
  const filteredQueriesByDsAndSearchFilter = filterQueriesBySearchFilter(filteredQueriesByDs, searchFilter);
  const filteredQueriesToBeSorted = timeFilter
    ? filterQueriesByTime(filteredQueriesByDsAndSearchFilter, timeFilter)
    : filteredQueriesByDsAndSearchFilter;

  return sortQueries(filteredQueriesToBeSorted, sortOrder);
}

export const createUrlFromRichHistory = (query: RichHistoryQuery) => {
  const exploreState: ExploreUrlState = {
    /* Default range, as we are not saving timerange in rich history */
    range: { from: 'now-1h', to: 'now' },
    datasource: query.datasourceName,
    queries: query.queries,
    context: 'explore',
  };

  const serializedState = serializeStateToUrlParam(exploreState);
  const baseUrl = /.*(?=\/explore)/.exec(`${window.location.href}`)![0];
  const url = urlUtil.renderUrl(`${baseUrl}/explore`, { left: serializedState });
  return url;
};

/* Needed for slider in Rich history to map numerical values to meaningful strings */
export const mapNumbertoTimeInSlider = (num: number) => {
  let str;
  switch (num) {
    case 0:
      str = 'today';
      break;
    case 1:
      str = 'yesterday';
      break;
    case 7:
      str = 'a week ago';
      break;
    case 14:
      str = 'two weeks ago';
      break;
    default:
      str = `${num} days ago`;
  }

  return str;
};

export function createDateStringFromTs(ts: number) {
  return dateTimeFormat(ts, {
    format: 'MMMM D',
  });
}

export function getQueryDisplayText(query: DataQuery): string {
  /* If datasource doesn't have getQueryDisplayText, create query display text by
   * stringifying query that was stripped of key, refId and datasource for nicer
   * formatting and improved readability
   */
  const strippedQuery = omit(query, ['key', 'refId', 'datasource']);
  return JSON.stringify(strippedQuery);
}

export function createQueryHeading(query: RichHistoryQuery, sortOrder: SortOrder) {
  let heading = '';
  if (sortOrder === SortOrder.DatasourceAZ || sortOrder === SortOrder.DatasourceZA) {
    heading = query.datasourceName;
  } else {
    heading = createDateStringFromTs(query.ts);
  }
  return heading;
}

export function createQueryText(query: DataQuery, queryDsInstance: DataSourceApi | undefined) {
  /* query DatasourceInstance is necessary because we use its getQueryDisplayText method
   * to format query text
   */
  if (queryDsInstance?.getQueryDisplayText) {
    return queryDsInstance.getQueryDisplayText(query);
  }

  return getQueryDisplayText(query);
}

export function mapQueriesToHeadings(query: RichHistoryQuery[], sortOrder: SortOrder) {
  let mappedQueriesToHeadings: any = {};

  query.forEach((q) => {
    let heading = createQueryHeading(q, sortOrder);
    if (!(heading in mappedQueriesToHeadings)) {
      mappedQueriesToHeadings[heading] = [q];
    } else {
      mappedQueriesToHeadings[heading] = [...mappedQueriesToHeadings[heading], q];
    }
  });

  return mappedQueriesToHeadings;
}

/* Create datasource list with images. If specific datasource retrieved from Rich history is not part of
 * exploreDatasources add generic datasource image and add property isRemoved = true.
 */
export function createDatasourcesList(queriesDatasources: string[]) {
  const datasources: Array<{ label: string; value: string; imgUrl: string; isRemoved: boolean }> = [];

  queriesDatasources.forEach((dsName) => {
    const dsSettings = getDataSourceSrv().getInstanceSettings(dsName);
    if (dsSettings) {
      datasources.push({
        label: dsSettings.name,
        value: dsSettings.name,
        imgUrl: dsSettings.meta.info.logos.small,
        isRemoved: false,
      });
    } else {
      datasources.push({
        label: dsName,
        value: dsName,
        imgUrl: 'public/img/icn-datasource.svg',
        isRemoved: true,
      });
    }
  });
  return datasources;
}

export function notEmptyQuery(query: DataQuery) {
  /* Check if query has any other properties besides key, refId and datasource.
   * If not, then we consider it empty query.
   */
  const strippedQuery = omit(query, ['key', 'refId', 'datasource']);
  const queryKeys = Object.keys(strippedQuery);

  if (queryKeys.length > 0) {
    return true;
  }

  return false;
}
