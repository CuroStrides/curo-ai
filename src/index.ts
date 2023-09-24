import { OpenAI } from 'openai'
import { Pinecone } from '@pinecone-database/pinecone'
import { type Stream } from 'openai/src/streaming'
import { type ChatCompletionCreateParamsBase, type ChatCompletionMessageParam } from 'openai/src/resources/chat/completions'
import { type ChatCompletionChunk } from 'openai/resources/chat'

export interface ClientOptions {
  openAiAPIKey: string
  model: ChatCompletionCreateParamsBase['model']
  initialPrompt?: string
  pinecone: {
    environment: string
    apiKey: string
  }
}

export interface ChatCompletionRequestMessage {
  /**
   * The role of the messages author. One of `system`, `user`, `assistant`, or `function`.
   * @type {string}
   * @memberof ChatCompletionRequestMessage
   */
  'role': 'system' | 'user' | 'assistant' | 'function'
  /**
   * The contents of the message. `content` is required for all messages except assistant messages with function calls.
   * @type {string}
   * @memberof ChatCompletionRequestMessage
   */
  'content'?: string
  /**
   * The name of the author of this message. `name` is required if role is `function`, and it should be the name of the function whose response is in the `content`. May contain a-z, A-Z, 0-9, and underscores, with a maximum length of 64 characters.
   * @type {string}
   * @memberof ChatCompletionRequestMessage
   */
  'name'?: string
}

export interface CompletionInput {
  messages: ChatCompletionMessageParam[]
  user: {
    uid: string
    firstName: string
  }
}

export default class CuroAI {
  private readonly openAI: typeof OpenAI['prototype']
  private readonly pinecone: typeof Pinecone['prototype']
  model?: ChatCompletionCreateParamsBase['model'] = 'gpt-3.5-turbo-16k'
  /**
     * API Client for interfacing with the Curo AI.
     *
     * @param {string} [opts.openAIAPIKey] - Your OpenAI API Key.
     * @param {string} [opts.model] - Which openAI model to use, defaults to gpt-3.5-turbo-16k
     * @param {number} [opts.pinecone.environment] - Pinecone environment.
     * @param {number} [opts.pinecone.apiKey] - Pinecone API Key.
     * @param {number} [opts.initialPrompt] - An initial prompt to provide when starting a new conversation
     */
  constructor (opts: ClientOptions) {
    this.openAI = new OpenAI({
      apiKey: opts.openAiAPIKey
    })

    this.model = opts.model || this.model
    this.pinecone = new Pinecone(opts.pinecone)
  }

  async getCompletionStream (input: CompletionInput): Promise<Stream<ChatCompletionChunk>> {
    const { messages, user } = input
    const { uid } = user
    const newMessage = messages[messages.length - 1]
    const isNewConversation = messages.length === 1
    const embeddingResponse = await this.openAI.embeddings.create({
      model: 'text-embedding-ada-002',
      input: newMessage.content
    })
    const index = this.pinecone.Index('messages-index')
    if (!isNewConversation) {
      const vectorSearchResult = await index.query({
        vector: embeddingResponse?.data[0]?.embedding,
        filter: {
          userId: uid,
          messageFrom: 'user'
        },
        includeMetadata: true,
        topK: 10
      })

      if (vectorSearchResult?.matches?.length) {
        const userReferences =
            vectorSearchResult.matches.map((item) =>
                `"${(item.metadata as { messageContent: string })?.messageContent}"`).join('\n')
        const systemMessage = `These are the references the user has talked about something similar already:
                       ${userReferences}.
                       Use it accordingly as required for the next response, while acknowledging you remember it (if necessary).
                    `
        const response = await this.openAI.chat.completions.create({
          model: this.model,
          messages: [...messages, {
            role: 'system',
            content: systemMessage
          }],
          stream: true,
          temperature: 0.6
        }, {
          stream: true
        })
        // @ts-expect-error
        return response
      }
    }
    await index.upsert([{
      id: `${uid}:${new Date().getTime().toString()}`,
      values: embeddingResponse?.data[0]?.embedding,
      metadata: {
        userId: uid,
        messageContent: newMessage.content,
        messageFrom: newMessage.role
      }
    }])

    const response = await this.openAI.chat.completions.create({
      model: this.model,
      messages,
      temperature: 0.6,
      stream: true
    }, {
      stream: true
    })
    // @ts-expect-error
    return response
  }
}
