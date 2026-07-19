# Publishing soundbird

The site is live at **<https://riavi04.github.io/soundbird/>**, served by GitHub
Pages from the `docs/` folder of this repository.

## Updating it

Say what you want changed and Claude will edit, rebuild and push. Or run it
yourself:

```sh
cd ~/Projects/sound-bird
./deploy.sh "what changed"
```

That rebuilds the page, commits, and pushes. The live site follows about a
minute later. Behind it:

```sh
python3 src/build.py dist/sound-bird.html    # writes docs/index.html
git add -A && git commit -m "..." && git push
```

`build.py` writes `docs/index.html`, which is the file Pages serves, so a plain
rebuild plus push is all a deploy needs.

## The link for Ben

Either works:

- The live site: <https://riavi04.github.io/soundbird/>
- The Claude artifact:
  <https://claude.ai/code/artifact/9b05c645-905f-474a-8e58-41155d2f3cfc>

The artifact is kept in step with the site, so either link can be sent and both
keep working when the page is updated.

## Things worth remembering

- **The repository is public.** The source, the whole commit history and the
  personal intro cards are readable by anyone, and GitHub is searchable.
- **The licenses travel with it.** Recordings are CC BY-NC, so non-commercial
  only. Several photographs are ShareAlike, which applies to the resized copies
  served here. Every recordist and photographer is credited on their card and
  listed in [CREDITS.md](CREDITS.md).

## Turning it off

Making the repository private switches Pages off automatically on a free plan,
which takes the site down. To remove it entirely:

```sh
gh repo delete soundbird
```

## Offline copy

`dist/standalone.html` is the same page as one 6.4 MB file that needs no
internet once opened. Double clicking it works.
