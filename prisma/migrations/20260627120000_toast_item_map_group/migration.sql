-- Add menu-group / menu context to ToastItemMap (sourced from the published Menus API).
ALTER TABLE "ToastItemMap" ADD COLUMN IF NOT EXISTS "toastGroup" TEXT;
ALTER TABLE "ToastItemMap" ADD COLUMN IF NOT EXISTS "toastMenu" TEXT;
