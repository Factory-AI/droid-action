export function validateEnvironmentVariables() {
  const factoryApiKey = process.env.FACTORY_API_KEY;

  if (!factoryApiKey || factoryApiKey.trim() === "") {
    throw new Error(
      "FACTORY_API_KEY is required to run Droid Exec. Please provide the factory_api_key input.",
    );
  }
}
