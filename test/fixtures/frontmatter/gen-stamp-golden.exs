# Regenerates test/fixtures/frontmatter/stamp-golden.json from the SERVER's own
# code — `RoleCall.Test.Stamp` (its port of `stampRcId`) and
# `RoleCall.Entities.Frontmatter.unstamp_candidates/3` — so the plugin's stamp
# is pinned to the bytes RoleCall expects. Loads the source files into a fresh
# VM; nothing in the server checkout is compiled or written.
#
#   S=../rolecall-ex-w2n; B=$S/_build/dev/lib
#   elixir -pa $B/jason/ebin -pa $B/typeid_elixir/ebin -pa $B/ecto/ebin \
#     test/fixtures/frontmatter/gen-stamp-golden.exs $S test/fixtures/frontmatter/stamp-golden.json
#
# Then copy $S/test/fixtures/frontmatter/obsidian/*.md over
# test/fixtures/frontmatter/obsidian/ (the corpus cases name those files).
[server, out] = System.argv()
Code.put_compiler_option(:ignore_module_conflict, true)
for f <- ~w(lib/rolecall_ex/obsidian/frontmatter/reader.ex lib/rolecall_ex/obsidian/frontmatter/patch.ex
            lib/rolecall_ex/obsidian/frontmatter.ex lib/rolecall_ex/entities/frontmatter.ex
            test/support/frontmatter_ports.ex),
    do: Code.require_file(Path.join(server, f))

alias RoleCall.Test.Stamp
alias RoleCall.Entities.Frontmatter, as: EF

corpus_dir = Path.join(server, "test/fixtures/frontmatter/obsidian")
corpus = corpus_dir |> File.ls!() |> Enum.sort() |> Enum.map(&{"corpus:" <> &1, File.read!(Path.join(corpus_dir, &1))})

stored = "npc_01j9xk3f2m8qzr7w4e6t1yzzzz"

heads = [
  [], ["type: npc"], ["race: Elf", "goals: |-", "  a", "  b"], ["race: Elf", "goals: |+", "  kept", ""],
  ["rc_id: #{stored}"], ["rc_id: '#{stored}'"], [~s(rc_id: "#{stored}")], ["rc_id:"], ["rc_id: "],
  ["rc_id:   #{stored}  "], ["rc_id:\t#{stored}"], ["type: npc", "rc_id:", "race: Elf"],
  ["# comment", "aliases:", "  - Bob", "rc_id: #{stored}"]
]

shapes =
  for {fence, fi} <- Enum.with_index(["---", "--- ", "---\t", "---  "]),
      {e, ei} <- Enum.with_index(["\n", "\r\n"]),
      {head, hi} <- Enum.with_index(heads),
      {body, bi} <- Enum.with_index(["", "Body", "Body\n", "# H\n\ntext\n"]) do
    {"shape:f#{fi}e#{ei}h#{hi}b#{bi}",
     fence <> e <> Enum.map_join(head, &(&1 <> e)) <> "---" <> e <> String.replace(body, "\n", e)}
  end

extra =
  Enum.with_index([
    "", "\n", "---\n---\n", "---\r\n---\r\n", "plain\r\nCRLF body\r\n", "plain", "# H\n", "---",
    "﻿# Bob\n", "﻿---\nrace: Elf\n---\n", "---\nno closing fence\n", "---\r\nno closing\r\n",
    "--- \n", "---\t\r\nbody", "---\nrc_id: other\n---\n", "---\n\n---\nBody\n", "---\n\n\n---\n\nBody",
    "----\nrace: Elf\n---\n", "--- x\nrace: Elf\n---\n", "---\nrace: Elf\n---", "---\nrace: Elf\n---  \n\nBody\n",
    "---\r\nrace: Elf\r\n---\r\nBody\r\n", "---\n名前: 太郎\n---\n本文\n", "# Bob\nrc_id: npc_x\n",
    "---\nrace: Elf\n---\nrc_id: npc_x\n", "---\n# rc_id: npc_x\n---\n", "---\nstats:\n  rc_id: npc_x\n---\n",
    "---\nrc_id : npc_x\n---\n", "---\nrc_id:npc_x\n---\n", "---\nrc_id: a # note\n---\n",
    "---\nrc_id: one\nrc_id: two\n---\n", "---\nrc_id:   \n---\n", "---\nrc_id: a\rb\nrace: Elf\n---\n",
    "---\ngoals: |\n  line\n\n  more\nrc_id: npc_x\n---\n", "---\naliases: [Bob, Bobby]\n---\nBody",
    "---\ntype: npc\n---\n---\nsecond block\n---\n", "\n---\nrace: Elf\n---\n", " ---\nrace: Elf\n---\n",
    "---\r\n", "---\n", "---\nrace: Elf\n--- \t\r\nBody", "---\n---", "---\n ---\n---\n",
    "---\v\nrace: Elf\n---\n", "text\n---\nrace: Elf\n---\n", "---\nrc_id: \"\"\n---\n", "---\nrc_id: []\n---\n"
  ])
  |> Enum.map(fn {t, i} -> {"extra:#{i}", t} end)

ids = ["npc_01j9xk3f2m8qzr7w4e6t1yabcd", "group_01j9xr2d6h8s3f5a7b9c1eghjk"]
sha = fn t -> :crypto.hash(:sha256, t) |> Base.encode16(case: :lower) end

cases =
  for {name, text} <- corpus ++ shapes ++ extra, id <- ids, replace <- [false, true] do
    stamped = Stamp.stamp(text, id, replace)

    inverse =
      case stamped do
        nil -> nil
        s -> sha.(text) in Enum.map(EF.unstamp_candidates(s, id, text), sha)
      end

    source =
      case name do
        "corpus:" <> file -> %{file: file}
        _ -> %{text: text}
      end

    Map.merge(source, %{name: name, id: id, replace: replace, expected: stamped,
      server_inverts: inverse, stampable: EF.stampable?(text)})
  end

File.write!(out, Jason.encode!(cases) |> String.replace("},{", "},\n{"))
IO.puts("#{length(cases)} cases; stamped #{Enum.count(cases, & &1.expected)}; not inverted: #{inspect(for c <- cases, c.expected && c.server_inverts == false, do: {c.name, c.replace})}")
