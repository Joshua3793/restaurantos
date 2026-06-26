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
import { BookOpen } from 'lucide-react'

// "View recipe" glyph — the same BookOpen mark the Recipes nav uses, shared by the
// desktop board row and the mobile compact row so the affordance is consistent.
export const IcRecipe = ({ size = 14 }: { size?: number }) => <BookOpen size={size} />
