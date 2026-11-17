// The plugin's bb.host entry. bb runs this plugin's agent through the SDK's
// published ACP bridge, the same bridge bb's own ACP agents plugin uses; the
// provider declaration in provider.ts tells it what to launch.
export { experimental_acpProviderBridge as experimental_providerBridge } from "@get-bb/plugin-sdk/provider-bridge/acp";
