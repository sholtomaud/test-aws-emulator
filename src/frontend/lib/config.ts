/** Runtime configuration, served as /config.json next to the app. */
export interface AppConfig {
  /** Base URL of the REST API, e.g. https://abc.execute-api.us-east-1.amazonaws.com/prod/ */
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
