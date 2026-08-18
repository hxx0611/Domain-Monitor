import { redirect } from "next/navigation";
import { getDictionary, getLocale } from "@/lib/i18n";
import { lookup } from "@/lib/i18n/display";
import { isAdminAuthenticated, isAdminConfigured } from "@/lib/auth/admin";
import { LoginForm } from "@/components/auth/login-form";
import { LanguageSwitcher } from "@/components/language-switcher";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (!isAdminConfigured()) {
    redirect("/setup");
  }
  if (await isAdminAuthenticated()) {
    redirect("/");
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
            {lookup(dict, "auth.loginTitle")}
          </h1>
          <p className="mb-6 text-sm text-gray-500">{lookup(dict, "auth.loginDescription")}</p>
          <LoginForm dict={dict} />
        </div>
      </div>
    </main>
  );
}
