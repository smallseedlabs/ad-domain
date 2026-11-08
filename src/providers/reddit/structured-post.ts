import type { AdsCreative } from '../../domain/creative.js';

/**
 * Official Create Structured Post Creation Job body `data.creative`.
 * IMAGE destination.url is the caller landingPageUrl (exact).
 * TEXT has no destination in OpenAPI; landing URL is applied on Create Ad click_url.
 */
export function toRedditStructuredPostData(
  creative: AdsCreative,
  landingPageUrl: string
): { creative: Record<string, unknown> } {
  if (creative.type === 'IMAGE') {
    const destination: Record<string, unknown> = {
      type: 'URL',
      url: landingPageUrl,
    };
    if (creative.callToAction) destination.call_to_action = creative.callToAction;
    return {
      creative: {
        type: 'IMAGE',
        headline: creative.headline,
        ...(creative.body ? { body: creative.body } : {}),
        image: { media: { type: 'URL', url: creative.mediaUrl } },
        destination,
      },
    };
  }
  return {
    creative: {
      type: 'TEXT',
      headline: creative.headline,
      body: creative.body,
      text_format: creative.textFormat ?? 'PLAIN_TEXT',
    },
  };
}

export function jobPostId(data: Record<string, unknown> | undefined): string | undefined {
  const id = data?.post_id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

export function jobStatus(data: Record<string, unknown> | undefined): string | undefined {
  const status = data?.status;
  return typeof status === 'string' ? status : undefined;
}
