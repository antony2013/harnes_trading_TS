import * as UpstoxClient from 'upstox-js-sdk'

// Set the OAuth2 access token from env. Get it via the login/OAuth flow.
// See: https://upstox.com/developer/api-documentation
const accessToken = process.env.UPSTOX_ACCESS_TOKEN ?? ''

const defaultClient = UpstoxClient.ApiClient.instance
const OAUTH2 = defaultClient.authentications['OAUTH2']
OAUTH2.accessToken = accessToken

// To use the sandbox environment instead, replace the two lines above with:
//   const defaultClient = new UpstoxClient.ApiClient(true)
//   defaultClient.authentications['OAUTH2'].accessToken = 'SANDBOX_ACCESS_TOKEN'

export { UpstoxClient }
export { defaultClient as upstoxClient }