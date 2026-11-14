/** Runtime configuration, served as /config.json next to the app. */
export interface AppConfig {
  /** Where the browser sends API requests: `/api`, on the site's own origin (CloudFront). */
  apiUrl: string;
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  /** Overrides the Cognito endpoint. Set by the local gateway; absent on AWS. */
  cognitoEndpoint?: string;
}

export const loadConfig = async (fetchImpl: typeof fetch = fetch): Promise<AppConfig> => {
  const response = await fetchImpl('config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load config.json (HTTP ${response.status})`);
  return (await response.json()) as AppConfig;
};
