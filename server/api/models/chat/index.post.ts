import { Readable } from 'stream'
import { formatDocumentsAsString } from "langchain/util/document"
import { PromptTemplate } from "@langchain/core/prompts"
import { RunnableSequence } from "@langchain/core/runnables"
// import { CohereRerank } from "@langchain/cohere"
import { CohereRerank } from "@/server/rerank/cohere"
import { setEventStreamResponse } from '@/server/utils'
import { BaseRetriever } from "@langchain/core/retrievers"
import prisma from "@/server/utils/prisma"
import { createChatModel, createEmbeddings } from '@/server/utils/models'
import { createRetriever } from '@/server/retriever'
import { AIMessage, BaseMessage, BaseMessageLike, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { resolveCoreference } from '~/server/coref'
import { concat } from "@langchain/core/utils/stream"
import { MODEL_FAMILIES } from '~/config'
import { McpService } from '@/server/utils/mcp'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { ChatOllama } from '@langchain/ollama'
import { tool } from '@langchain/core/tools'
import { BaseChatModel, BaseChatModelCallOptions } from '@langchain/core/language_models/chat_models'
import { z } from "zod"
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

interface RequestBody {
  knowledgebaseId: number
  model: string
  family: string
  messages: {
    role: 'user' | 'assistant'
    content: string
    toolCallId?: string
    toolResult: boolean
  }[]
  stream: any
}

interface ToolCall {
  name: string
  // Add other properties as needed
}

interface GatheredResponse {
  tool_calls?: ToolCall[]
  // Add other properties that might be in the gathered response
}

interface ChatModelCallOptions extends BaseChatModelCallOptions {
  tools?: any[]
}

const SYSTEM_TEMPLATE = `Answer the user's question based on the context below.
Present your answer in a structured Markdown format.

If the context doesn't contain any relevant information to the question, don't make something up and just say "I don't know":

<context>
{context}
</context>

<chat_history>
{chatHistory}
</chat_history>

<question>
{question}
</question>

Answer:
`

const serializeMessages = (messages: RequestBody['messages']): string =>
  messages.map((message) => `${message.role}: ${message.content}`).join("\n")

const transformMessages = (messages: RequestBody['messages']): BaseMessageLike[] =>
  messages.map((message) => [message.role, message.content])

const normalizeMessages = (messages: RequestBody['messages']): BaseMessage[] => {
  const normalizedMessages = []
  for (const message of messages) {
    if (message.toolResult) {
      normalizedMessages.push(new ToolMessage(message.content, message.toolCallId!))
    } else if (message.role === "user") {
      normalizedMessages.push(new HumanMessage(message.content))
    } else if (message.role === "assistant") {
      normalizedMessages.push(new AIMessage(message.content))
    }
  }

  return normalizedMessages
}

export default defineEventHandler(async (event) => {
  const { knowledgebaseId, model, family, messages, stream } = await readBody<RequestBody>(event)

  if (knowledgebaseId) {
    console.log("Chat with knowledge base with id: ", knowledgebaseId)
    const knowledgebase = await prisma.knowledgeBase.findUnique({
      where: {
        id: knowledgebaseId,
      },
    })
    console.log(`Knowledge base ${knowledgebase?.name} with embedding "${knowledgebase?.embedding}"`)
    if (!knowledgebase) {
      setResponseStatus(event, 404, `Knowledge base with id ${knowledgebaseId} not found`)
      return
    }

    const embeddings = createEmbeddings(knowledgebase.embedding!, event)
    const retriever: BaseRetriever = await createRetriever(embeddings, `collection_${knowledgebase.id}`) as BaseRetriever

    const chat = createChatModel(model, family, event)
    const query = messages[messages.length - 1].content
    console.log("User query: ", query)

    const reformulatedResult = await resolveCoreference(
      query,
      normalizeMessages(messages),
      process.env.OPENAI_API_KEY
    )
    const reformulatedQuery = reformulatedResult.output || query
    console.log("Reformulated query: ", reformulatedQuery)

    const relevant_docs = await retriever.getRelevantDocuments(reformulatedQuery)
    console.log("Relevant documents: ", relevant_docs)

    let rerankedDocuments = relevant_docs

    if ((process.env.COHERE_API_KEY || process.env.COHERE_BASE_URL) && process.env.COHERE_MODEL) {
      const options = {
        apiKey: process.env.COHERE_API_KEY,
        baseUrl: process.env.COHERE_BASE_URL,
        model: process.env.COHERE_MODEL,
        topN: 4
      }
      console.log("Cohere Rerank Options: ", options)
      const cohereRerank = new CohereRerank(options)
      rerankedDocuments = await cohereRerank.compressDocuments(relevant_docs, reformulatedQuery)
      console.log("Cohere reranked documents: ", rerankedDocuments)
    }

    const chain = RunnableSequence.from([
      {
        question: (input: { question: string; chatHistory?: string }) =>
          input.question,
        chatHistory: (input: { question: string; chatHistory?: string }) =>
          input.chatHistory ?? "",
        context: async () => {
          return formatDocumentsAsString(rerankedDocuments)
        },
      },
      PromptTemplate.fromTemplate(SYSTEM_TEMPLATE),
      chat
    ])

    if (!stream) {
      const response = await chain.invoke({
        question: query,
        chatHistory: serializeMessages(messages),
      })

      return {
        message: {
          role: 'assistant',
          content: response?.content,
          relevant_docs
        }
      }
    }

    setEventStreamResponse(event)
    const response = await chain.stream({
      question: query,
      chatHistory: serializeMessages(messages),
    })

    const readableStream = Readable.from((async function* () {
      for await (const chunk of response) {
        if (chunk?.content !== undefined) {
          const message = {
            message: {
              role: 'assistant',
              content: chunk?.content
            }
          }
          yield `${JSON.stringify(message)} \n\n`
        }
      }

      const docsChunk = {
        type: "relevant_documents",
        relevant_documents: rerankedDocuments
      }
      yield `${JSON.stringify(docsChunk)} \n\n`
    })())
    return sendStream(event, readableStream)
  } else {
    const calculatorSchema = z.object({
      operation: z
        .enum(["add", "subtract", "multiply", "divide"])
        .describe("The type of operation to execute."),
      number1: z.number().describe("The first number to operate on."),
      number2: z.number().describe("The second number to operate on."),
    })

    const calculatorTool = tool(
      async ({ operation, number1, number2 }) => {
        // Functions must return strings
        if (operation === "add") {
          return `${number1 + number2}`
        } else if (operation === "subtract") {
          return `${number1 - number2}`
        } else if (operation === "multiply") {
          return `${number1 * number2}`
        } else if (operation === "divide") {
          return `${number1 / number2}`
        } else {
          throw new Error("Invalid operation.")
        }
      },
      {
        name: "calculator",
        description: "Can perform mathematical operations.",
        schema: calculatorSchema,
      }
    )
    const transport = new StdioClientTransport({
      command: "C:\\Users\\DaWil\\AppData\\Local\\Microsoft\\WinGet\\Packages\\astral-sh.uv_Microsoft.Winget.Source_8wekyb3d8bbwe\\uvx.exe",
      args: ["mcp-server-sqlite", "--db-path", "C:\\Users\\DaWil\\test.db"],
    })
    const client = new Client({
      name: "chatollama-client",
      version: "1.0.0",
    }, {
      capabilities: {}
    })
    await client.connect(transport)
    const toolsResponse = await client.listTools()
    const mcpTools = toolsResponse.tools.map((t) => {
      const _Tool = tool(
        async (args) => {
          // Functions must return strings
          const result = await client.callTool({
            name: t.name,
            arguments: args
          })
          console.log(result)
          return result
        },
        {
          name: t.name,
          description: t.description,
          schema: t.inputSchema,
        }
      )
      return _Tool
    })
    let llm = createChatModel(model, family, event) as BaseChatModel
    if (mcpTools.length > 0) {
      llm = llm.bind({ tools: mcpTools } as ChatModelCallOptions) as BaseChatModel
    }

    const mcpService = new McpService()
    const normalizedTools: any[] = (await mcpService.listTools()) ?? []
    let toolsMap: Record<string, any> = {}
    if (normalizedTools && normalizedTools.length > 0) {
      toolsMap = normalizedTools.reduce((acc, tool) => {
        acc[tool.name] = tool
        return acc
      }, {} as Record<string, any>)
    }
    if (family === MODEL_FAMILIES.anthropic && normalizedTools?.length) {
      llm = llm.bind({ tools: normalizedTools } as ChatModelCallOptions) as BaseChatModel
    } else if (llm instanceof ChatOllama && normalizedTools?.length) {
      llm = llm.bind({ tools: normalizedTools } as ChatModelCallOptions) as BaseChatModel
    }

    if (!stream) {
      const response = await llm.invoke(transformMessages(messages))
      console.log(response)
      return {
        message: {
          role: 'assistant',
          content: response?.content
        }
      }
    }

    console.log("Streaming response")
    const response = await llm?.stream(messages.map((message: RequestBody['messages'][number]) => {
      return [message.role, message.content]
    }))

    console.log(response)

    let gathered: GatheredResponse | undefined = undefined

    const readableStream = new ReadableStream({
      async start(controller) {
        for await (const chunk of response) {
          gathered = gathered !== undefined ? concat(gathered, chunk) : chunk

          let content = chunk?.content

          // Handle array of text_delta objects
          if (Array.isArray(content)) {
            content = content
              .filter(item => item.type === 'text_delta' && 'text' in item)
              .map(item => (item as { text: string }).text)
              .join('')
          }

          const message = {
            message: {
              role: 'assistant',
              content: chunk?.content
            }
          }
          controller.enqueue(`${JSON.stringify(message)} \n\n`)
        }

        // Process tool calls after the main response
        if (gathered?.tool_calls?.length) {
          for (const toolCall of gathered.tool_calls) {
            console.log("Tool call: ", toolCall)
            const selectedTool = toolsMap[toolCall.name]

            if (selectedTool) {
              const result = await selectedTool.invoke(toolCall)
              console.log("Tool result: ", result)

              const message = {
                message: {
                  role: "user",
                  type: "tool_result",
                  tool_use_id: result.tool_call_id,
                  content: result.content
                }
              }

              controller.enqueue(`${JSON.stringify(message)} \n\n`)
            }
          }
        }
      }
    })

    return sendStream(event, readableStream)
  }
})
