import { createFileRoute } from '@tanstack/react-router'
import { BotsPage } from '../pages/bots/BotsPage'

export const Route = createFileRoute('/bots')({ component: BotsPage })
