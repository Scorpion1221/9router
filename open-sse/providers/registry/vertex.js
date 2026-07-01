export default {
  id: "vertex",
  priority: 40,
  alias: "vertex",
  aliases: [
    "vx",
  ],
  uiAlias: "vx",
  display: {
    name: "Vertex AI",
    icon: "cloud",
    color: "#4285F4",
    textIcon: "VX",
    website: "https://cloud.google.com/vertex-ai",
    notice: {
      text: "New Google Cloud accounts get $300 free credits. Requires GCP project + Service Account with Vertex AI API enabled.",
      apiKeyUrl: "https://console.cloud.google.com/iam-admin/serviceaccounts",
    },
  },
  category: "freeTier",
  hasProviderSpecificData: true,
  transport: {
    baseUrl: "https://aiplatform.googleapis.com",
    format: "vertex",
  },
  models: [
    { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" },
    { id: "gemini-3.1-flash-lite-preview", name: "Gemini 3.1 Flash Lite Preview" },
    { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview" },
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash" },
  ],
  serviceKinds: ["llm", "embedding", "imageToText"],
  embeddingConfig: {
    baseUrl: "https://aiplatform.googleapis.com/v1/publishers/google/models",
    authType: "apikey",
    authHeader: "bearer",
    models: [
      { id: "gemini-embedding-2-preview", name: "Gemini Embedding 2 (Preview)", dimensions: 3072 },
      { id: "gemini-embedding-001", name: "Gemini Embedding 001", dimensions: 3072 },
      { id: "text-embedding-005", name: "Text Embedding 005", dimensions: 768 },
      { id: "text-multilingual-embedding-002", name: "Text Multilingual Embedding 002", dimensions: 768 },
    ],
  },
};
