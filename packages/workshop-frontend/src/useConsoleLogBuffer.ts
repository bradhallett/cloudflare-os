import { useCallback, useEffect, useRef, useState } from 'react'
import { RpcTarget } from 'capnweb'
import type { ConsoleLogEvent, ConsoleLogSubscriber } from '@gadgets/workshop-shared/api'

type BufferedLogEntry = ConsoleLogEvent & { source: 'server' | 'client' }

/** Renders the buffered log entries as a console transcript for the Activity pane. */
export function formatConsoleLogs(logs: BufferedLogEntry[]): string {
  const lines = logs.map(log => {
    const parts = log.message.map(p => (typeof p === 'string' ? p : JSON.stringify(p)))
    return `[${log.source} ${log.level}] ${parts.join(' ')}`
  })
  return 'Console logs:\n' + lines.join('\n')
}

class ConsoleLogSubscriberImpl extends RpcTarget implements ConsoleLogSubscriber {
  selectedChatIdRef: { current: number | null } = { current: null }
  logBufferRef: { current: BufferedLogEntry[] } = { current: [] }
  onBufferUpdated: () => void = () => {}

  async event(chatId: number | null, logs: ConsoleLogEvent[]) {
    for (const log of logs) {
      const method = (console as any)[log.level] ?? console.log
      method('server:', ...log.message)
    }
    // If the logs are not associated with any chat, deliver to the current chat. If they are
    // associated with a chat, this implies that the logs come from a version of the gadget that
    // has proposed changes from that chat; only deliver if it matches the current chat.
    if (chatId === null || chatId === this.selectedChatIdRef.current) {
      this.logBufferRef.current.push(...logs.map(l => ({ ...l, source: 'server' as const })))
      this.onBufferUpdated()
    }
  }
}

/**
 * Buffers the selected chat's gadget console output (server pushes via the subscription, client
 * logs via the iframe bridge) for the Activity pane to consume or discard. Switching chats
 * drops the buffer: entries belong to the chat that produced them.
 */
export function useConsoleLogBuffer(selectedChatId: number | null) {
  const selectedChatIdRef = useRef(selectedChatId)
  selectedChatIdRef.current = selectedChatId
  const subscriberRef = useRef(new ConsoleLogSubscriberImpl())
  const bufferRef = useRef<BufferedLogEntry[]>([])
  const [count, setCount] = useState(0)

  subscriberRef.current.selectedChatIdRef = selectedChatIdRef
  subscriberRef.current.logBufferRef = bufferRef
  subscriberRef.current.onBufferUpdated = () => setCount(bufferRef.current.length)

  useEffect(() => {
    bufferRef.current = []
    setCount(0)
  }, [selectedChatId])

  const consumeConsoleLogs = useCallback((): string => {
    const logs = bufferRef.current
    bufferRef.current = []
    setCount(0)
    return formatConsoleLogs(logs)
  }, [])

  const discardConsoleLogs = useCallback(() => {
    bufferRef.current = []
    setCount(0)
  }, [])

  const handleClientConsoleLog = useCallback((log: ConsoleLogEvent) => {
    const method = (console as any)[log.level] ?? console.log
    method('client:', ...log.message)
    if (selectedChatIdRef.current !== null) {
      bufferRef.current.push({ ...log, source: 'client' as const })
      setCount(bufferRef.current.length)
    }
  }, [])

  return {
    subscriber: subscriberRef.current,
    count,
    bufferRef,
    consumeConsoleLogs,
    discardConsoleLogs,
    handleClientConsoleLog,
  }
}
