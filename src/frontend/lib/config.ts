/** Runtime configuration, served as /config.json next to the app. */
export interface AppConfig {
  /** Where the browser sends API requests: `/api`, on the site's own origin (CloudFront). */
  apiUrl: string;
  /**
   * The API Gateway stage URL CloudFront forwards /api/* to, e.g.
   * https://abc.execute-api.us-east-1.amazonaws.com/prod/. Requests are signed
   * for this host and path, which is what API Gateway receives.
   */
  apiSigningUrl: string;
  region: string;
  userPoolId: string;
  userPoolClientId: string;
  identityPoolId: string;
  /** Override the Cognito endpoints. Set by the local gateway; absent on AWS. */
  cognitoEndpoint?: string;
  identityEndpoint?: string;
}

export const loadConfig = async (fetchImpl: typeof fetch = fetch): Promise<AppConfig> => {
  const response = await fetchImpl('config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`Could not load config.json (HTTP ${response.status})`);
  return (await response.json()) as AppConfig;
};
