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
      call_to_action: creative.callToAction ?? 'LEARN_MORE',
    };
    const body = creative.body
      ? creative.body.includes(landingPageUrl)
        ? creative.body
        : `${creative.body.trimEnd()}\n\n${landingPageUrl}`
      : undefined;
    return {
      creative: {
        type: 'IMAGE',
        headline: creative.headline,
        ...(body ? { body } : {}),
        image: { media: { type: 'URL', url: creative.mediaUrl } },
        destination,
      },
    };
  }
  const body = creative.body.includes(landingPageUrl)
    ? creative.body
    : `${creative.body.trimEnd()}\n\n${landingPageUrl}`;
  return {
    creative: {
      type: 'TEXT',
      headline: creative.headline,
      body,
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
