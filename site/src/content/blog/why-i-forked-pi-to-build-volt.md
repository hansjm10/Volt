---
title: "Why I Forked Pi to Build Volt"
description: "How experimenting with coding-agent harnesses led me from Pi extensions to building Volt."
publishedAt: 2026-08-24
author: Jordan Hans
image: /blog/why-i-forked-pi-to-build-volt-og.png
tags:
  - product
  - engineering
  - pi
draft: false
---

## The wrong controller

I got really addicted to working on side projects and wanting to “token-max” my [Codex](https://github.com/openai/codex) subscription. One workflow I tried was setting up a tmux session on my home server and leaving it alive indefinitely. I’d remote in through Termius on my iPhone, use a few macros to enter the live session, and start prompting from bed.

This worked well enough. With Tailscale, I could connect while away from home and run everything I needed. The problems started when I needed to do anything beyond a simple “build X” prompt. If I needed to read longer output, such as a code review, the Termius keyboard got in the way, scrolling through tmux would break, or the screen was simply too small. It gave me access from my phone, but it didn’t feel like a native phone experience.

I had a professor for a game design class who was always experimenting with different controllers and building games around them so the game matched the controller. Working over SSH felt like I was using the wrong controller for my game.

## Find a starting point

At the time, I was writing tools inside Codex and experimenting with whether a model-facing tool should be native or provided through [MCP](https://modelcontextprotocol.io/docs/getting-started/intro). One of those tools accessed a SQL Server database. An MCP server was available, but it hadn’t been touched in a few months, and its tool definitions added a ton of context to every conversation.

I’m very passionate about trimming context. I still don’t know the best approach: lazy-loading tools, using skills plus a CLI, or running an MCP server. As models have grown stronger, the question has started to feel less relevant, but I still go back and forth on it.

The big issue with working on Codex was iteration. Recompiling Codex took too long for my ADHD. I love Rust’s type safety, and I think having a model work inside a Rust ecosystem provides a lot of safeguards, but it wasn’t fast enough for instant gratification.

I thought I could just build my own harness. I grabbed a pen and paper and, under the heading “Agent,” wrote down exactly what I thought I might need:

- Compaction
- Cost input/output
- History
- System Prompt
- User input/output
- Some shell
- MCP?

A big arrow pointed from all of it to: “Find starting point.”

Well, I went and found my starting point. It didn’t take long. I had already heard of [Pi](https://github.com/earendil-works/pi) while reading Reddit, so the name was familiar. I took one look at it and thought it was awesome. Literally everything I had been thinking about was already there, and it was lightweight. I could build it in less than 30 seconds and try adjustments on the fly.

There were already [extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/README.md) for [MCP support](https://github.com/nicobailon/pi-mcp-adapter), [subagents](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/subagent), and even a [`/goal` command](https://github.com/mitsuhiko/agent-stuff/commit/ab79f98104bcd3c6a7c5491e609f6d6700a7414d). If something didn’t exist, I could just make it myself.

I cloned Pi, and one of the first changes I made was [adding a bounding box around the input](https://github.com/volt-hq/Volt/commit/fd3cd9218). At the time, Pi had a line above and below where you typed, so I added bars on each side to close the box. It felt a bit more natural to me.

## Giving the fork a name

From there, I started adding more extensions and small tweaks, moving some extensions into the core package, and editing the system prompt. The project started to grow, and working across different machines made me want to package everything together.

Realistically, that started with maintaining a fork across multiple machines and trying to keep all the extensions in the same place. Once the setup grew, including everything up front was easier than recreating it on each machine.

Part of playing around was giving the fork the name Volt. It didn’t have much meaning beyond being the name of one of my MapleStory characters. I just wanted something fun and energetic. I [changed the ASCII startup screen](https://github.com/volt-hq/Volt/commit/42105ff4e) to say Volt, and we went from there.

## Remembering Iroh

Around the same time I started diving into Volt, I [read about Iroh 1.0 on Hacker News](https://news.ycombinator.com/item?id=48542480). I thought it was cool but didn’t pay much attention. Later, while in the shower, I remembered Iroh. I thought, damn, I wonder if I could use this to stream text?

I went to work learning [what Iroh actually was](https://docs.iroh.computer/what-is-iroh) and asked “The Guy” (ChatGPT) how feasible it would be with Pi or Volt. It pointed out that a proof of concept could be pretty simple because Pi already had [RPC support](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/rpc.md) baked in. I made a [small Pi sidecar](https://github.com/volt-hq/Volt/commit/5ed4ef587) that transmitted RPC over Iroh. Then I had a model spin up a quick iPhone app that scanned a QR code and connected to my PC. It worked right out of the box.

I pretty much never stopped working on Volt after that, taking massive advantage of Codex’s usage resets. I was also dogfooding Volt: working on Volt from inside the TUI or the app felt natural. I added image support so I could take screenshots of the app and show what I wanted to change. I added an easy way to upload diagnostics over Iroh. Then, all of a sudden, I didn’t really have an extension anymore. Volt had its own identity.

## When Volt became its own thing

After working on the app for a while, I realized I might have a product. It solved a lot of the problems I had with remote development. I started thinking of Volt less as a fun experiment and more as something I might actually ship. Don’t get me wrong, it was still fun. It just wasn’t a Pi extension anymore.

I didn’t want users who found the app first to then have to download Pi and install an extension, or a whole suite of extensions. I also didn’t want to rely on Pi for Volt’s compatibility. What if an update broke something I needed? I didn’t want to bog down Pi’s maintainers with my own pull requests or with support questions from app users either. Optimistic, I know.

As I merged more features and split code apart for cross-platform compatibility, keeping up with upstream became harder. I think that’s when Volt became its own thing.

Working on Volt as a solo maintainer has been difficult, and it has given me a lot of appreciation for Pi’s contributors, particularly [Mario Zechner](https://github.com/badlogic). One of the hardest parts has been adding the features Volt needs while also keeping up with model and provider updates. I’ve selectively brought over work such as [fullscreen support](https://github.com/earendil-works/pi/pull/7440) and a handful of bug fixes.

The reality is that Volt is still Pi at its core. Pi’s RPC foundation, session model, and provider layer still underpin Volt, which remains derived from Pi under the [MIT License](https://github.com/earendil-works/pi/blob/main/LICENSE). It has just been shaped for me and, I hope, for other people too.

## Experimentation is fun

Volt has easily been the most fun side project I’ve worked on. At what point does it become a project instead of a side project? I don’t know; we can talk about that another day.

If I had to create Volt again, I would 100% choose to fork Pi. I’ve been experimenting with harnesses in some form since OpenAI [introduced JSON mode](https://openai.com/index/new-models-and-developer-products-announced-at-devday/). Even before that, I tried to force it by telling the model: `ONLY REPLY IN JSON.` It’s kind of crazy how much progress has been made over the past few years.

If I were starting over, maybe I wouldn’t have created so many proofs of concept. A few of my experiments grew too broad and ate up a lot of time. That’s also where I had the most fun, though, so I’ll continue to waste some of my time on random proofs of concept and experiments that might eventually bear fruit.
