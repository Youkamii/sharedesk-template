export default function JoinCodeForm() {
  return (
    <form action="/api/invitations/code" method="post" className="mt-6 space-y-3">
      <label className="block space-y-1.5 text-left text-sm font-medium">
        <span>초대 코드</span>
        <input
          required
          name="code"
          type="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={96}
          placeholder="XXXX-XXXX-XXXX-XXXX-…"
          className="w-full rounded-lg border border-black/10 bg-transparent px-3 py-2.5 font-mono text-sm uppercase tracking-wide outline-none focus:border-blue-500 dark:border-white/15"
        />
      </label>
      <button
        type="submit"
        className="flex w-full items-center justify-center rounded-lg bg-foreground py-2.5 font-medium text-background"
      >
        코드로 데스크 가입
      </button>
    </form>
  );
}
