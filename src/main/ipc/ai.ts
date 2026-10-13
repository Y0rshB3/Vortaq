import type { AppContext } from '../context'
import { getAiService } from '../ai'
import type { HandleFn } from './router'

/**
 * AI assistant channels. Keys only travel renderer -> main (setKey, test,
 * listModels); nothing here returns a key. Requests carry structure only.
 */
export function registerAiHandlers(ctx: AppContext, handle: HandleFn): void {
  const ai = (): ReturnType<typeof getAiService> => getAiService(ctx)

  handle('ai:providers', () => ai().listProviders())
  handle('ai:saveProvider', (input) => ai().saveProvider(input))
  handle('ai:deleteProvider', (id) => {
    ai().deleteProvider(id)
    if (ctx.settings.get().aiDefaultProviderId === id)
      ctx.settings.update({ aiDefaultProviderId: null })
  })
  handle('ai:testProvider', (input, key) => ai().testProvider(input, key))
  handle('ai:setKey', (id, key) => ai().setKey(id, key))
  handle('ai:hasKey', (id) => ai().hasKey(id))
  handle('ai:listModels', (input, key) => ai().listModels(input, key))
  handle('ai:chat', (request) => ai().startChat(request))
  handle('ai:cancel', (requestId) => ai().cancel(requestId))
  handle('ai:conversations', (connectionId) => ai().conversations.list(connectionId))
  handle('ai:conversation', (connectionId, id) => ai().conversations.get(connectionId, id))
  handle('ai:saveConversation', (input) => ai().conversations.save(input))
  handle('ai:deleteConversation', (connectionId, id) => ai().conversations.delete(connectionId, id))
  handle('ai:memory', (connectionId, schema) => ai().memory.get(connectionId, schema))
  handle('ai:setMemory', (connectionId, schema, text) =>
    ai().memory.set(connectionId, schema, text)
  )
  handle('ai:contextPreview', (request) => ai().buildContext(request, { fresh: true }))
}
