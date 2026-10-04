// The item drawer's sections. The shell (../InventoryItemDrawer.tsx) owns data
// loading, edit mode, the sheets and the section order; each file here renders one
// section from explicit props.
export { Header, HeaderBadges, HeaderFacts } from './Header'
export { CostBasisRow, PriceBlock, CostBasisBlock } from './CostLine'
export { BoxesSection } from './BoxesSection'
export { BridgesSection, PackChainReadout } from './BridgesSection'
export { StockSection } from './StockSection'
export { HistorySection } from './HistorySection'
export { ItemEditForm } from './EditForm'
export * from './types'
