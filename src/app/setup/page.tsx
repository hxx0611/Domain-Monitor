import { getDictionary, getLocale } from "@/lib/i18n";
import { lookup } from "@/lib/i18n/display";
import { SetupForm } from "@/components/auth/setup-form";
import { LanguageSwitcher } from "@/components/language-switcher";

export const dynamic = "force-dynamic";

/**
 * First-run setup wizard.
 *
 * NOTE: deliberately does NOT redirect when the install is already
 * configured. A server-action success triggers an RSC refresh of this
 * page; if that refresh redirected to `/`, the one-time recovery code
 * (shown by the client component) would never be visible. The security
 * boundary is provided by `/` (requirePageAccess → /setup) and by
 * setupAdminAction itself (returns alreadyConfigured when a second setup
 * is attempted) — a repeat visit just shows the form again.
 */
export default async function SetupPage() {
  const locale = await getLocale();
  const dict = getDictionary(locale);

  return (
    <main className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-between">
          <span className="text-sm font-medium text-gray-500">{dict.common.appName}</span>
          <LanguageSwitcher locale={locale} />
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <h1 className="mb-1 text-xl font-bold tracking-tight">
            {lookup(dict, "auth.setupTitle")}
          </h1>
          <p className="mb-6 text-sm text-gray-500">{lookup(dict, "auth.setupDescription")}</p>
          <SetupForm dict={dict} />
        </div>
      </div>
    </main>
  );
}
