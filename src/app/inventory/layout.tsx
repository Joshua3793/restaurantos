export default function InventoryLayout({ children }: { children: React.ReactNode }) {
  // v2: Storage Areas / Categories / Count Stock moved out of /inventory.
  // Storage + Categories now live under /setup; Count is top-level at /count.
  return <>{children}</>
}
