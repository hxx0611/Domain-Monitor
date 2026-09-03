import { redirect } from "next/navigation";
import { getDictionary, getLocale } from "@/lib/i18n";
import { lookup } from "@/lib/i18n/display";
import { getRepository } from "@/lib/runtime/repository";
import { RecoverForm } from "@/components/auth/recover-form";
import { LanguageSwitcher } from "@/components/language-switcher";

export const dynamic = "force-dynamic";

/**
 * Password recovery page.
 *
 * Redirects unconfigured installs to /setup. Deliberately does NOT
 * redirect authenticated visitors away: a successful recovery establishes
 * a session, and the RSC refresh after the server action would redirect
 * before the client component could show the NEW one-time recovery code.
 * The recovery code (and its single-show guarantee) lives in the client
 * component's local state.
 */
export default async function RecoverPage() {
  const repo = await getRepository();
  if (!(await repo.isAdminConfigured())) {
    redirect("/setup");
  }
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
            {lookup(dict, "auth.recoverTitle")}
          </h1>
          <p className="mb-6 text-sm text-gray-500">{lookup(dict, "auth.recoverDescription")}</p>
          <RecoverForm dict={dict} />
        </div>
      </div>
    </main>
  );
}
