import { SYSTEM_PROMPT_DEFAULT } from "@/lib/config"
import { getAllModels } from "@/lib/models"
import { getProviderForModel } from "@/lib/openproviders/provider-map"
import type { ProviderWithoutOllama } from "@/lib/user-keys"
import { measureAsync } from "@/lib/utils"
import { Attachment } from "@ai-sdk/ui-utils"
import { Message as MessageAISDK, streamText, ToolSet } from "ai"
import {
  logUserMessage,
  storeAssistantMessage,
  validateAndTrackUsage,
} from "./api"
import { createErrorResponse, extractErrorMessage } from "./utils"
import { loadMCPToolsFromURL } from "@/lib/mcp/load-mcp-from-url"
import { trackSpecialAgentUsage } from "./api"
import { cleanMessagesForTools, handleStreamError, type ApiError } from "./utils"

export const maxDuration = 60

type ChatRequest = {
  messages: MessageAISDK[]
  chatId: string
  userId: string
  model: string
  isAuthenticated: boolean
  systemPrompt: string
  enableSearch: boolean
}

// Cache for model configurations to avoid repeated lookups
const modelCache = new Map<string, any>()
const MODEL_CACHE_TTL = 5 * 60 * 1000 // 5 minutes

// Cache for agent configurations
const agentCache = new Map<string, any>()
const AGENT_CACHE_TTL = 10 * 60 * 1000 // 10 minutes

export async function POST(req: Request) {
  try {
    const body = await req.json()
    console.log('Incoming /api/chat payload:', body)
    const allModels = await getAllModels()
    console.log('Available models:', allModels.map(m => m.id))
    const {
      messages,
      chatId,
      userId,
      model,
      isAuthenticated,
      systemPrompt,
      enableSearch,
    } = body as ChatRequest

    if (!messages || !chatId || !userId) {
      return new Response(
        JSON.stringify({ error: "Error, missing information" }),
        { status: 400 }
      )
    }

    const userMessage = messages[messages.length - 1]

    // Define agentId as undefined for now (future: extract from payload if agent support is added)
    const agentId = undefined

    // Start parallel operations for better performance
    const operations = {
      // Essential operations that must complete before streaming
      essential: Promise.all([
        // Validate usage and get supabase client
        measureAsync("validate-usage", () => 
          validateAndTrackUsage({
            userId,
            model,
            isAuthenticated,
          })
        ),
        // Get model configuration (with caching)
        measureAsync("get-model-config", () => getModelConfig(model)),
        // Get agent configuration (with caching)
        agentId ? measureAsync("get-agent-config", () => getAgentConfig(agentId)) : Promise.resolve(null),
      ]),
    }

    // Wait for essential operations
    const [supabase, modelConfig, agentConfig] = await operations.essential

    if (!modelConfig || !modelConfig.apiSdk) {
      throw new Error(`Model ${model} not found`)
    }

    if (supabase && userMessage?.role === "user") {
      // Log user message in background (non-blocking)
      logUserMessage({
        supabase,
        userId,
        chatId,
        content: userMessage.content,
        attachments: userMessage.experimental_attachments as Attachment[],
        model,
        isAuthenticated,
      }).catch(console.error) // Don't block on errors
    }

    const effectiveSystemPrompt =
      agentConfig?.systemPrompt || systemPrompt || SYSTEM_PROMPT_DEFAULT

    let toolsToUse = undefined

    // Load tools in parallel if agent has them
    if (agentConfig?.mcpConfig) {
      const { tools } = await measureAsync("load-mcp-tools", () => 
        loadMCPToolsFromURL(agentConfig.mcpConfig.server)
      )
      toolsToUse = tools
    } else if (agentConfig?.tools) {
      toolsToUse = agentConfig.tools
      // Track special agent usage in background
      if (supabase) {
        trackSpecialAgentUsage(supabase, userId).catch(console.error)
      }
    }

    // Clean messages when switching between agents with different tool capabilities
    const hasTools = !!toolsToUse && Object.keys(toolsToUse).length > 0
    const cleanedMessages = cleanMessagesForTools(messages, hasTools)

    let streamError: ApiError | null = null

    let apiKey: string | undefined
    if (isAuthenticated && userId) {
      const { getEffectiveApiKey } = await import("@/lib/user-keys")
      const provider = getProviderForModel(model)
      apiKey =
        (await getEffectiveApiKey(userId, provider as ProviderWithoutOllama)) ||
        undefined
    }

    // Measure stream text performance manually since it doesn't return a Promise
    const streamStart = performance.now()
    const result = streamText({
      model: modelConfig.apiSdk(apiKey, { enableSearch }),
      system: effectiveSystemPrompt,
      messages: cleanedMessages,
      tools: toolsToUse as ToolSet,
      maxSteps: 10,
      onError: (err: unknown) => {
        streamError = handleStreamError(err)
      },

      onFinish: async ({ response }) => {
        const streamDuration = performance.now() - streamStart
        console.log(`Stream completed in ${streamDuration.toFixed(2)}ms`)
        
        console.log("API onFinish called with response:", {
          chatId,
          messageCount: response.messages.length,
          messages: response.messages.map(m => ({
            role: m.role,
            content: typeof m.content === 'string' ? m.content.substring(0, 50) : 'complex content'
          }))
        })
        if (supabase) {
          try {
            // Ensure only the very last assistant message is saved
            const lastAssistantMessage = response.messages.findLast(
              (m) => m.role === "assistant"
            )

            if (lastAssistantMessage) {
              console.log("Attempting to save assistant message:", { id: lastAssistantMessage.id, content: typeof lastAssistantMessage.content === 'string' ? lastAssistantMessage.content.substring(0, 50) : 'complex content' })
              console.trace("Call stack for saving assistant message")
              await storeAssistantMessage({
                supabase,
                chatId,
                userId,
                // Pass only the last assistant message in an array
                messages: [lastAssistantMessage] as unknown as import("@/app/types/api.types").Message[],
              })
              console.log("Assistant message saved successfully in API route (forced save)")
            } else {
              console.log("No new assistant message found to save in API route.")
            }

          } catch (error) {
            console.error("Failed to save assistant message in API route:", error)
          }
        } else {
          console.log("No supabase client available for assistant message saving - Supabase not configured")
          // Fallback: Save to local storage via client-side
          console.log("Messages will be saved locally via client-side cache only")
        }
      },
    })

    if (streamError) {
      throw streamError
    }

    const originalResponse = result.toDataStreamResponse({
      sendReasoning: true,
      sendSources: true,
    })

    return new Response(originalResponse.body, {
      status: originalResponse.status,
    })
  } catch (err: unknown) {
    console.error("Error in /api/chat:", err)
    const error = err as {
      code?: string
      message?: string
      statusCode?: number
    }

    return createErrorResponse(error)
  }
}

// Helper function to get model config with caching
async function getModelConfig(modelId: string) {
  const now = Date.now()
  const cached = modelCache.get(modelId)
  
  if (cached && now - cached.timestamp < MODEL_CACHE_TTL) {
    return cached.config
  }

  const allModels = await getAllModels()
  const modelConfig = allModels.find((m) => m.id === modelId)
  
  if (modelConfig) {
    modelCache.set(modelId, {
      config: modelConfig,
      timestamp: now
    })
  }
  
  return modelConfig
}

// Helper function to get agent config with caching
async function getAgentConfig(agentId: string) {
  const now = Date.now()
  const cached = agentCache.get(agentId)
  
  if (cached && now - cached.timestamp < AGENT_CACHE_TTL) {
    return cached.config
  }

  const agentConfig = await loadAgent(agentId)
  
  if (agentConfig) {
    agentCache.set(agentId, {
      config: agentConfig,
      timestamp: now
    })
  }
  
  return agentConfig
}

// Add a placeholder for loadAgent at the bottom of the file
async function loadAgent(agentId: string) {
  // TODO: Implement agent loading logic
  return null
}
