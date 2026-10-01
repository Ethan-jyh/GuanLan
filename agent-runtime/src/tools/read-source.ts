import { EvidenceStore } from '../storage/evidence-store.js';

export interface ReadSourceParams {
  url_or_ref: string;
  extract_summary?: boolean;
  run_id?: string;
}

export interface ReadSourceResult {
  status: 'success' | 'not_found' | 'error';
  source_ref?: string;
  is_full_text?: boolean;
  content?: string;
  length?: number;
  message?: string;
  error?: string;
}

export type FetchBackendFn = (url: string) => Promise<string | null> | (string | null);

export async function readSource(
  params: ReadSourceParams,
  evidenceStore?: EvidenceStore,
  fetchBackend?: FetchBackendFn
): Promise<ReadSourceResult> {
  const urlOrRef = params.url_or_ref?.trim();
  if (!urlOrRef) {
    return {
      status: 'error',
      error: 'URL or reference cannot be empty',
    };
  }

  try {
    let fullText: string | null = null;
    if (fetchBackend) {
      fullText = await fetchBackend(urlOrRef);
    } else {
      try {
        const resp = await fetch(urlOrRef, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)',
          },
          signal: AbortSignal.timeout(10000),
        });
        if (resp.ok) {
          fullText = await resp.text();
        }
      } catch {
        fullText = null;
      }
    }

    if (!fullText) {
      return {
        status: 'not_found',
        source_ref: urlOrRef,
        message: 'Unable to fetch content from target source',
      };
    }

    if (params.run_id && evidenceStore) {
      evidenceStore.addEvidence({
        run_id: params.run_id,
        source_type: 'webpage_fulltext',
        source_ref: urlOrRef,
        title: 'Source Full Text',
        excerpt: fullText.length > 300 ? `${fullText.slice(0, 300)}...` : fullText,
        is_full_text: true,
      });
    }

    return {
      status: 'success',
      source_ref: urlOrRef,
      is_full_text: true,
      content: fullText,
      length: fullText.length,
    };
  } catch (err: any) {
    return {
      status: 'error',
      source_ref: urlOrRef,
      error: err.message,
    };
  }
}
