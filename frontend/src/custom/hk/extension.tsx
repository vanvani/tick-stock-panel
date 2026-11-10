import { lazy } from 'react'
import { Landmark } from 'lucide-react'
import type { FrontendExtension } from '@/extensions/types'

export const HkMarket = lazy(() => import('./Page').then(m => ({ default: m.HkMarket })))

const extension: FrontendExtension = {
  id: 'custom.hk-market',
  apiVersion: 1,
  routes: [{ id: 'hk-market', path: '/hk', component: HkMarket }],
  navigation: [{ id: 'hk-market', routeId: 'hk-market', label: '港股', icon: Landmark, order: 65 }],
}

export default extension
