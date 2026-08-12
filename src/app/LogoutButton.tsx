"use client";

import { useRouter } from "next/navigation";

export default function LogoutButton({
  className = "text-sm text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100",
}: {
  className?: string;
}) {
  const router = useRouter();
  return (
    <button
      className={className}
      onClick={async () => {
        await fetch("/api/auth", { method: "DELETE" });
        router.replace("/");
        router.refresh();
      }}
    >
      로그아웃
    </button>
  );
}
