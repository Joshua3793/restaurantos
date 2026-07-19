import { redirect } from 'next/navigation'

// Service type + hours are configured per revenue center in the RC editor.
export default function ServicesSetupRedirect() {
  redirect('/setup/revenue-centers')
}
