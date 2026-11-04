# pi-clm

`pi-clm` is a [Pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
extension for model-managed context. The model edits a local conversation snapshot with
ordinary file tools. Accepted edits change the next request,
not the canonical session history.

This independent fork of [lolipopshock/pi-clm](https://github.com/lolipopshock/pi-clm)
starts from upstream 1.0.0 (`b84a9d7`). Default CLM mode retains upstream
editing, deletion, reordering, and whole-context summary replacement.
The upstream MIT license, copyright notice for Emanuel Casco, and history are retained.
The project implements ideas from
[Context Language Models](https://arxiv.org/pdf/2609.37725) and its
[research codebase](https://github.com/facebookresearch/context-language-models).

## Fork additions

- Transactional edit acceptance at request boundaries and final settlement, with explicit in-flight call checks.
- Durable overflow text files that survive mirror cleanup and session reopening.
- Source-aware snapshots and keyed archive recovery for hosts with the matching SDK APIs.
- A read-only accepted context for native compaction, without consuming pending edits or notices.
- Optional callable-only exposure for the existing annotation/recall helpers.

The [architecture reference](docs/architecture.md) describes these mechanisms and their limits.

## Install

```sh
pi install git:github.com/clankerwrangler/pi-clm

# Try one session without installing:
pi -e git:github.com/clankerwrangler/pi-clm
```

This fork is distributed as TypeScript source directly from GitHub; it has no separate
build step or npm release. Pi loads the package's `index.ts` entry. Your Pi installation
supplies the runtime SDK. The development lock pins Pi 0.99.1; source-aware host
integration uses additional fork APIs. See [SDK compatibility](docs/development.md#sdk-compatibility)
for the matched Pi 1.5.0 source baseline and fallback behavior.

## Quick start

| command | what it does |
|---------|--------------|
| `/clm` | open the panel: **overview** (context size over time + compaction points) <br><img src=".github/images/overview.png" alt="The overview page: context size per request, with two points where the model compacted its own context" width="720"> <br> **input** (what the next request contains) · **edits** (per-revision side-by-side diff) <br><img src=".github/images/edits.png" alt="The edits page: a tool result before and after the model shortened it" width="720">|
| `/clm status` | three lines: next request vs budget, edits, changed settings |
| `/clm config` | open **settings**; `/clm config <setting> <value>` changes one, `/clm config reset` drops this session's changes<br><img src=".github/images/settings.png" alt="The settings page: sizes, guard, files, and every setting" width="720"> |
| `/clm-compact [instructions]` | send a labeled CLM maintenance message asking the model to compact its context; anything you add (e.g. what to keep) is passed along. The result shows on the **edits** page |
| `/clm on` / `off` / `reset` | enable, use raw context, discard the projection |

In the panel: `1–4` or `Tab` switch pages, `← →` step through compaction points, `z`
zooms the chart, `Enter` opens the selection, `q` closes.

## Docs

- [How it works](docs/how-it-works.md) — the mirror, what runs without the model, the panel, safety.
- [Configuration](docs/configuration.md) — budget, reserve, reminders, guard, steering and the other settings.
- [Architecture](docs/architecture.md) — the system as implemented, design notes, known limitations.
- [Development](docs/development.md) — setup, tests, model checks.

## Citation

If you use pi-clm in your research, please cite
[Context Language Models](https://arxiv.org/abs/2609.37725):

```bibtex
@article{shao2026context,
  title   = {Context Language Models},
  author  = {Shao, Rulin and Shen, Shannon Zejiang and Yin, Junjie Oscar and Li, Yuetai and
             Wang, Minheng and Ivison, Hamish and Poovendran, Radha and Lambert, Nathan and
             Xiao, Teng and Lewis, Mike and Yih, Wen-tau and Zettlemoyer, Luke and Koh, Pang Wei},
  journal = {arXiv preprint arXiv:2609.37725},
  year    = {2026}
}
```
