export function setupTestEnvVars() {
  return {
    apiHost: process.env.V3_API_HOST || '',
    nodeHost: process.env.NODE_PROXY_HOST || '',
    nodeKey: process.env.NODE_PROXY_KEY || '',
  };
}
