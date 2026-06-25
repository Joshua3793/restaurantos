// Stable icon aliases for the prep redesign.
// Sourced from lucide-react@1.7.0 — verified names against
// node_modules/lucide-react/dist/lucide-react.d.ts.
//
// Substitutions vs. task spec:
//   IcMore → Ellipsis  (MoreHorizontal does not exist in 1.7.0; Ellipsis is the equivalent)
export {
  TriangleAlert as IcAlert,
  Check         as IcCheck,
  Play          as IcPlay,
  Ellipsis      as IcMore,
  ShoppingCart  as IcCart,
  Contrast      as IcHalf,
  RotateCcw     as IcUndo,
  SkipForward   as IcSkip,
  Ban           as IcBlock,
  Clock         as IcClock,
  RefreshCw     as IcRefresh,
  ChefHat       as IcSync,
  Plus          as IcPlus,
  CalendarDays  as IcCalendar,
  ChevronRight  as IcChevron,
  X             as IcX,
} from 'lucide-react'

// "View recipe" glyph — a custom recipe-card mark shared by the desktop board row
// and the mobile compact row so the affordance is identical across renderers.
export const IcRecipe = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M4 4h12a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4V4z" />
    <path d="M4 16a4 4 0 0 1 4-4h12" />
  </svg>
)
