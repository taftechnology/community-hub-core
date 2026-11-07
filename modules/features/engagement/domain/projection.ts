export const PUBLIC_SERVICE_TIMES_COLUMNS = ["content_html"] as const;

export interface PublicServiceTimes {
  readonly html: string;
}

export function toPublicServiceTimes(row: { content_html: string }): PublicServiceTimes {
  return {
    html: row.content_html,
  };
}
