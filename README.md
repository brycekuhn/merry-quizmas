# 🎄 Merry Quizmas

**📱 Phones join here: [brycekuhn.github.io/merry-quizmas](https://brycekuhn.github.io/merry-quizmas/)**

**📺 The TV opens: [brycekuhn.github.io/merry-quizmas/tv.html](https://brycekuhn.github.io/merry-quizmas/tv.html)**

A Christmas party game for about 10 people. One screen (a TV or laptop) runs the game. Everyone plays on their phone. Nobody installs anything or makes an account.

## The rounds

| Round | How it works |
| --- | --- |
| 🎄 Christmas trivia | Multiple choice. Faster right answers score more. |
| 🦌 Pin the nose on the reindeer | Rudolph appears for 3 seconds, then vanishes. Tap where his nose goes. The TV then shows everyone’s noses on him at once. |
| 🎯 Closest guess | Type a number or a year. The three closest score, and exact answers get a bonus. |
| 🤥 Fake fact | A real but strange tradition with a blank. Everyone writes a fake answer, then tries to find the real one. Fooling people scores. |
| 🕵️ Who said that? | While waiting in the lobby, each phone asks two questions about its player. Later, everyone guesses who wrote each answer. |
| 🏆 Most likely to… | Vote for someone in the room. Voting with the crowd scores. |
| ✨ Final trivia | Trivia worth double points. |

In the lobby, the host can turn rounds on or off and choose how many questions each has. The game avoids repeating questions from earlier games on the same TV until it runs out.

## Running a game

1. On the TV or laptop, open **`tv.html`**. It shows a room code and a QR code.
2. Guests scan the QR code, or go to the site and type the code. They pick a name and an emoji, then answer two quick questions while they wait.
3. Press **Start the game**. The big button in the corner (or Enter or Space) moves things along. Questions end on their own when everyone has answered or time runs out.

If the TV page gets refreshed, it offers to pick up where it left off. Phones that lock or reload rejoin automatically.

## Setup: Firebase (one time, about 10 minutes, free)

GitHub Pages can only serve files, so the game uses Firebase’s free Realtime Database to pass answers between phones and the TV. Until it’s set up, the game runs in **practice mode**, which only works between tabs in one browser.

1. Go to [console.firebase.google.com](https://console.firebase.google.com) and **Create a project**. Google Analytics isn’t needed.
2. **Build > Realtime Database > Create database.** Pick a location, then choose **Start in locked mode**.
3. In the database’s **Rules** tab, paste the contents of [`database.rules.json`](database.rules.json) and click **Publish**.
4. **Build > Authentication > Get started > Sign-in method:** turn on **Anonymous**.
5. **Authentication > Settings > Authorized domains:** add `brycekuhn.github.io`.
6. **Project settings** (the gear icon) **> Your apps:** add a **Web** app (`</>`). Copy the `firebaseConfig` it shows into [`firebase-config.js`](firebase-config.js).

The config values identify the project and aren’t secret; the database rules are what protect it. The free plan easily handles a party of this size.

## Hosting on GitHub Pages

GitHub Pages serves the site straight from the root of the `main` branch, with no build step; `.nojekyll` makes it serve the files exactly as they are. Pushing to `main` updates the live site within a minute or two.

## Editing the questions

Everything lives in [`content.json`](content.json):

- **trivia:** the first answer in `a` is the correct one. The game shuffles them. Add `"family": true` to make a question come up in every game. Family questions are spread across the trivia rounds and marked “🏡 Family question” on screen.
- **closest:** `answer` is a number. Add `unit` (like `"gifts"`), or leave it off for years.
- **fake:** `___` marks the blank. `accept` lists other ways of writing the real answer, so a player can’t submit the truth as a fake. `decoys` are fakes the game adds when there are only a few players.
- **superlatives** and **aboutYou:** plain lists of prompts.

Family in-jokes are where this game shines, so add your own.

## Family photos

A trivia question can show photos on the TV, either with the question or at the reveal. Because this repo is public, the photos are published **encrypted**. The TV asks for the family photo password once (the **Unlock** button in the lobby), remembers it, and decrypts the photos itself. Phones never load them.

To add a photo:

1. Put the original in `family-photos/`. That folder is never uploaded.
2. Add its file name to a question in `content.json`, like `"photos": ["popo-fireplace.jpg"]`. Photos show at the reveal by default. To show them with the question, add `"showPhotos": "question"`.
3. Run `node encrypt-photos.mjs`. It writes the locked copies to `photos/`.
4. Commit and push.

The password lives in `photo-password.txt`, which is also never uploaded. If you change it, run the script again and unlock the TV with the new one.

## Trying it on one computer

```
node serve.mjs
```

Open http://localhost:8090/tv.html, then click **Open a phone tab** a few times. Each tab is a separate player. Adding `?practice` to the address forces practice mode even after Firebase is set up.

## Files

| File | What it is |
| --- | --- |
| `index.html`, `phone.js` | The phone screen |
| `tv.html`, `tv.js` | The TV screen. It runs the game and does all the scoring. |
| `game.js` | Shared code: live sync (Firebase or practice mode), round settings, the reindeer drawing |
| `style.css` | Styles for both screens |
| `content.json` | Questions and prompts |
| `firebase-config.js`, `database.rules.json` | Firebase setup |
| `serve.mjs` | A tiny local web server for testing |
| `encrypt-photos.mjs`, `photos/` | Locks the family photos; `photos/` holds only the encrypted copies |
