export interface GetTimelineParams {
  topic_keyword: string;
  interval?: string;
  window?: string;
}

export interface TimelineDataPoint {
  time: string;
  index: number;
}

export interface GetTimelineResult {
  status: 'success' | 'data_unavailable' | 'error';
  topic?: string;
  interval?: string;
  window?: string;
  series?: TimelineDataPoint[];
  reason?: string;
  error?: string;
}

export type TimelineBackendFn = (
  keyword: string,
  interval: string,
  window: string
) => Promise<TimelineDataPoint[] | null> | (TimelineDataPoint[] | null);

export async function getTimeline(
  params: GetTimelineParams,
  timelineBackend?: TimelineBackendFn
): Promise<GetTimelineResult> {
  const topicKeyword = params.topic_keyword?.trim();
  if (!topicKeyword) {
    return {
      status: 'error',
      error: 'topic_keyword cannot be empty',
    };
  }

  const interval = params.interval || '1h';
  const window = params.window || '48h';

  try {
    let series: TimelineDataPoint[] | null = null;
    if (timelineBackend) {
      series = await timelineBackend(topicKeyword, interval, window);
    }

    if (!series || series.length === 0) {
      return {
        status: 'data_unavailable',
        topic: topicKeyword,
        reason: `No timeline trend data available for '${topicKeyword}' in window ${window}`,
      };
    }

    return {
      status: 'success',
      topic: topicKeyword,
      interval,
      window,
      series,
    };
  } catch (err: any) {
    return {
      status: 'error',
      topic: topicKeyword,
      error: err.message,
    };
  }
}
