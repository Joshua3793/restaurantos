// The item drawer's sections. The shell (../InventoryItemDrawer.tsx) owns data
// loading, edit mode, the sheets and the section order; each file here renders one
// section from explicit props.
export { Header, HeaderBadges, HeaderFacts } from './Header'
export { CostLine } from './CostLine'
export { BoxesSection } from './BoxesSection'
export { BridgesSection } from './BridgesSection'
export { SectionTitle } from './SectionTitle'
export { StockSection } from './StockSection'
export { HistorySection } from './HistorySection'
export { ItemEditForm } from './EditForm'
export * from './types'
