/* What the spoken summaries can say (js/app.js picks a line at random, fills
 * in the {placeholders} and capitalises the first letter). Many pools are an
 * opener crossed with a core sentence, so they read naturally in any
 * combination while giving lots of variety; an empty opener means the core is
 * said on its own.
 *
 * Placeholders: {N} {nm} {svc} service names, {few} "one outage" / "two
 * outages", {fewIs} "one outage is" / "two outages are", {n} a number word,
 * {at} " around City" (or ""), {place} where (shape depends on the pool),
 * {what}/{What} what went wrong, {when}/{When} when, {dur} how long, {ms}
 * milliseconds, {others} ", and so is Zoom" style tail, {v} a voice name.
 */
(function () {
  'use strict';

  /** Every opener with every core ("" opener = the core alone). */
  const X = (openers, cores) => {
    const out = [];
    for (const o of openers) for (const c of cores) out.push(o ? `${o} ${c}` : c);
    return out;
  };
  /** Every core with every tail appended. */
  const T = (cores, tails) => {
    const out = [];
    for (const c of cores) for (const t of tails) out.push(c + t);
    return out;
  };

  // ── This room, about one service (tapped outage, while active) ──────────
  const ROOM_OPEN = ['', 'And', 'Also,', 'Plus,', 'Worth noting:', 'And locally,'];
  const roomDown = X(ROOM_OPEN, [
    "it's not reachable from this room.", "we can't reach it from here, either.", "this room can't get to it right now.",
    "it's not answering from here.", "it's down from this room too.", "this room can't reach it at the moment.",
    "it isn't responding from here.", "we're cut off from it in this room.", "from here, it's not answering at all.",
    "this room is affected; it won't connect."]);
  const roomSlow = X(ROOM_OPEN, [
    'you might notice it here, too.', "it's a bit slow from this room.", "it's dragging a little from here.",
    "this room's seeing it slow down.", 'you may feel that one here.', "it's a touch sluggish from this room.",
    "it's slower than usual from here.", 'this room is feeling some of it.', 'responses from here are a bit sluggish.',
    "it's lagging a little in this room."]);
  const roomFine = X(['', 'Good news:', 'Thankfully,', 'Still,', 'Either way,', "For what it's worth,", 'Happily,', 'Luckily,', 'On the bright side,'], [
    "it's fine from this room.", 'from here, it still looks fine.', "this room isn't feeling it.",
    'from here, it still looks healthy.', "nothing's wrong from this room.", 'this room is getting through fine.',
    "it's still working fine from here.", 'here, it seems unaffected.', "from where we're sitting, it's fine.",
    'this room can still reach it without trouble.']);

  // ── Overview: how the internet is doing ─────────────────────────────────
  const healthCalm = X(['', 'Right now,', 'At the moment,', 'For now,', 'Good news:', 'Overall,'], [
    "the internet's in good shape.", 'things are calm on the internet.', "it's all quiet on the internet.",
    "nothing's broken out there.", "it's a calm moment on the internet.", "the internet's behaving itself.",
    'there are no active outages.', 'everything out there is running smoothly.', 'the internet looks healthy.',
    "there's nothing to worry about out there."]);
  const HEALTH_OPEN = ['', 'Right now,', 'At the moment,', 'For now,', 'Overall,', 'All in all,'];
  const healthFew = X(HEALTH_OPEN, [
    "it's mostly calm on the internet, with {few} still going.", "the internet's mostly healthy; just {fewIs} still going.",
    "it's pretty quiet out there, apart from {few}.", 'things look mostly fine, with {few} still open.',
    "the internet's in decent shape; {fewIs} still in progress.", "it's a fairly calm picture, with {few} still being worked on.",
    "there's not much going on, just {few}.", 'the internet is steady, with {few} still active.',
    "it's a quiet stretch, aside from {few}.", 'most things are running fine; {fewIs} still unresolved.']);
  const healthBusy = X(HEALTH_OPEN, [
    "it's a busy time on the internet, with {n} outages going.", "there's a fair bit going on: {n} active outages.",
    "the internet's a little rough, with {n} outages in progress.", "it's a noisy moment out there; {n} outages are active.",
    "there's quite a bit happening, {n} outages at once.", "it's not the calmest moment; {n} outages are still going.",
    'things are busy, with {n} outages underway.', "there's plenty going on; {n} outages are open.",
    "the internet's having a busy spell, with {n} active outages.", "it's a hectic stretch, {n} outages and counting."]);

  // ── Overview: the service with the worst of it ──────────────────────────
  const WATCH = ['', ' Worth keeping an eye on.', ' That one is worth watching.'];
  const worstActiveRepeat = T([
    '{N} is having the hardest time, on and off all day and still going now.', "{N} has had a rough day, and it's still not over.",
    "the one to watch is {N}; it's been up and down all day and is still having trouble.", "{N} keeps running into trouble today, and it's at it again now.",
    '{N} has struggled all day, and the latest issue is still open.', '{N} is having a tough one; several outages today, one still going.',
    "it's been a bad day for {N}, and it isn't done yet.", '{N} stands out, with trouble on and off all day and an outage still open.',
    "{N} has been the problem child today, and it's still acting up.", "{N} has had repeated outages today, and there's one going right now."], WATCH);
  const worstActiveOne = T([
    '{N} is the one to watch, with a problem going on now.', 'the main thing right now is {N}, which is having trouble.',
    '{N} is the story at the moment; it has an issue in progress.', '{N} is having a problem right now.',
    'the headline right now is {N}, with an outage in progress.', '{N} is down at the moment.',
    "{N} has an outage that's still open.", 'the big one right now is {N}.',
    '{N} is the one having trouble right now.', 'right now, all eyes are on {N}.'], WATCH);
  const worstPastRepeat = T([
    '{N} has had the roughest day, on and off.', '{N} has had a bumpy day, with trouble on and off.',
    "it's been an up and down day for {N}.", "{N} has had the most trouble today, though it's quiet now.",
    '{N} has had several outages today, all cleared now.', '{N} has been the least reliable today, on and off.',
    '{N} had a string of outages today, now resolved.', "{N} kept having trouble earlier, but it's settled down.",
    "today's most troubled service has been {N}.", "{N} has had a choppy day, though it's fine at the moment."],
  ['', ' Nothing open there right now, though.', ' All quiet there for now.']);
  const worstPastOne = T([
    "{N} had the biggest outage, though it's cleared now.", "the biggest one today was at {N}, and that's resolved.",
    '{N} had the most notable outage today, now cleared.', "{N} had today's largest outage, since fixed.",
    'the standout today was an outage at {N}, now over.', "{N} had the most widespread problem today; it's fine now.",
    "{N} took the biggest hit today, but it's recovered.", "the biggest disruption today was {N}, and it's back to normal.",
    '{N} had a sizable outage earlier, now cleared.', "the largest outage today hit {N}; it's resolved."],
  ['', ' Nothing serious since.', " It's been fine since."]);
  // "... and Amazon had <this>."
  const restTail = X(['a few', 'some', 'a couple of', 'a handful of', 'several', 'a few quick', 'some short', 'a couple of brief', 'some minor'], [
    'hiccups', 'blips', 'glitches', 'bumps', 'wobbles', 'hiccups too', 'blips as well', 'issues', 'disruptions', 'outages of their own']);

  // ── Overview: this room ─────────────────────────────────────────────────
  const overviewRoomFine = X(['', 'And', 'Meanwhile,', 'Closer to home,', 'Locally,', 'On our side,'], [
    'everything this room relies on is answering normally.', 'all the services you use look fine from here.',
    'this room is in good shape.', 'everything you use from this room is working.', 'all looks well from here.',
    "everything's answering fine from this room.", "this room's connections all look healthy.",
    "nothing's wrong with the services this room uses.", 'every service we check from here is fine.',
    'this room is getting through to everything.']);
  const NOTE = ['', 'One thing to note:', 'Closer to home,'];
  const overviewRoomDown = X(NOTE, [
    "from this room, {svc} isn't answering{others}.", "here, {svc} isn't reachable right now{others}.", "this room can't reach {svc}{others}.",
    '{svc} is down from here{others}.', "we can't get to {svc} from this room{others}.", "{svc} isn't responding from here{others}.",
    'this room is cut off from {svc}{others}.', "{svc} won't connect from this room{others}.", 'from here, {svc} is unreachable{others}.',
    "{svc} isn't getting through from this room{others}."]);
  const overviewRoomSlow = X(NOTE, [
    'from this room, {svc} is slower than usual{others}.', 'here, {svc} is a little slow right now{others}.', '{svc} is lagging from this room{others}.',
    '{svc} is a bit sluggish from here{others}.', 'this room is seeing {svc} slow down{others}.', '{svc} is dragging a little from here{others}.',
    'responses from {svc} are slow in this room{others}.', '{svc} is taking longer than usual from here{others}.', 'from here, {svc} feels slow{others}.',
    '{svc} is running slow for this room{others}.']);

  // ── New outage ──────────────────────────────────────────────────────────
  const headsUp = X(['Heads up:', 'Just in:', 'New outage:'], [
    '{nm} just went down{at}.', '{nm} is having trouble{at}.', '{nm} has a new problem{at}.', '{nm} just started having issues{at}.',
    "something's wrong at {nm}{at}.", '{nm} has gone down{at}.', '{nm} is reporting an outage{at}.', '{nm} just hit a snag{at}.',
    '{nm} is struggling{at}.', "there's a fresh outage at {nm}{at}."]);

  // ── A tapped outage: what's wrong (noun phrases) ────────────────────────
  // Noun phrases only, so they fit any sentence shape below.
  const NET = ['a network problem', 'trouble on its network', 'a problem in its network', 'a network issue', 'a fault in its network',
    'a routing problem', 'congestion on its network', 'a network outage', 'connectivity trouble', 'a problem in its backbone',
    'packet loss on its network', 'a network slowdown', 'a broken link somewhere in its network', 'routing trouble', 'an outage on its network',
    'a network disruption', 'a fault on its links', 'an interface problem', 'a network hiccup', 'a connectivity outage'];
  const APP = ['an application problem', 'trouble with its service', 'a service outage', 'unresponsive servers', 'a service slowdown',
    'an issue with its application', 'failing requests', 'a problem on its servers', 'timeouts on its service', 'errors from its service',
    'a service disruption', 'an app outage', 'server errors', 'slow responses from its servers', 'a backend problem',
    'an issue with its servers', 'requests timing out', 'a service failure', 'an application outage', 'trouble reaching its servers'];
  const whatNetNow = X(['', 'what looks like', 'what seems to be'], NET);
  const whatAppNow = X(['', 'what looks like', 'what seems to be'], APP);
  const whatNetThen = X(['', 'what looked like', 'what seemed to be'], NET);
  const whatAppThen = X(['', 'what looked like', 'what seemed to be'], APP);

  // {place} here is ", mostly around City and a few other places" (or "").
  const tappedActive = [
    "{nm}. {What}{place}, and it's still going.", '{nm}: {what}{place}. Still in progress.', "This is {nm}. {What}{place}, and it hasn't cleared yet.",
    "{nm}. {What}{place}. It's ongoing.", "Here's {nm}: {what}{place}, still unresolved.", "{nm} has {what}{place}, and it's still happening.",
    '{nm}. {What}{place}; no fix yet.', "That's {nm}, with {what}{place}. It's still going.", '{nm}, right now: {what}{place}.',
    "{nm}. {What}{place}, and it's not over yet.", '{nm} is dealing with {what}{place}.', 'Looking at {nm}: {what}{place}, still active.',
    '{nm}. Currently, {what}{place}.', '{nm}: still seeing {what}{place}.', "This one's {nm}. {What}{place}, ongoing.",
    "{nm}. {What}{place}, and it's active now.", '{nm} is in the middle of {what}{place}.', '{nm}. Reports show {what}{place}, still going.',
    '{nm}: {what}{place}, and counting.', '{nm}. Ongoing: {what}{place}.', 'So, {nm}. {What}{place}, still open.',
    '{nm}. {What}{place}. Not resolved yet.', '{nm} has an open issue: {what}{place}.', '{nm}. {What}{place}, as we speak.',
    '{nm}, live right now: {what}{place}.', "{nm}. It's {what}{place}, still going.", '{nm}. Seeing {what}{place} right now.',
    "{nm}: {what}{place}. They're still on it.", "{nm}. {What}{place}, and it's ongoing.", '{nm}. {What}{place}, unresolved so far.'];
  // {place} here is " around City and a few other places" (or "").
  const tappedCleared = [
    "{nm}. {When}, {what}{place}. It lasted {dur}, and it's cleared now.", '{nm} had {what}{place} {when}. That lasted {dur} and is resolved.',
    'This was {nm}, {when}{place}. {What} for {dur}, all clear now.', "{nm}. {When}, {what}{place}, for {dur}. It's fine now.",
    '{nm}: {what}{place}, {when}. Over after {dur}.', '{nm}. {What}{place}, {when}. It cleared after {dur}.',
    '{When}, {nm} had {what}{place}. It lasted {dur}.', "{nm}. {What}{place}, {when}, for {dur}. It's resolved.",
    "Looking back at {nm}: {what}{place}, {when}. It's been fixed.", '{nm}. {When}, {what}{place}. Back to normal after {dur}.',
    "{nm} ran into {what}{place} {when}, for {dur}. It's sorted now.", '{nm}. That was {when}: {what}{place}, for {dur}.',
    '{When}, {what}{place} at {nm}. It cleared after {dur}.', '{nm}. {What}{place}, {when}. All good now.',
    "This one's {nm}, {when}. {What}{place}, lasting {dur}.", '{nm}: {when}, {what}{place}. Resolved after {dur}.',
    "{nm}. {What}{place}, {when}, and it's over now.", '{nm} had {what}{place} {when}; it lasted {dur}.',
    '{nm}. {When}, {what}{place}. Fixed after {dur}.', "{nm}: {what}{place} {when}. It's cleared up.",
    '{nm}. A past one: {what}{place}, {when}, for {dur}.', "{nm}. {When}, {what}{place}. It didn't last; {dur}.",
    '{nm}. {What}{place}, {when}. Done after {dur}.', "Back {when}, {nm} had {what}{place}. It's fine now.",
    "{nm}: {what}{place}, {when}, for {dur}. It's recovered.", '{nm}. {When}, {what}{place}, which cleared after {dur}.',
    "{nm}. {What}{place}, {when}. It's been resolved.", '{nm} saw {what}{place} {when}. That lasted {dur}.',
    '{nm}. {When}: {what}{place}, over after {dur}.',
    "{nm}. {What}{place}, {when}. It's all clear."];

  // ── Path trace ──────────────────────────────────────────────────────────
  const pathStart = X(['', 'Okay,', 'Sure,'], [
    'let me trace the path to {svc}.', "I'll trace the route to {svc}.", "let's see how traffic gets to {svc}.",
    'tracing the path to {svc} now.', "I'm checking the route to {svc}.", "let's follow the path to {svc}.",
    'running a path trace to {svc}.', "let's see what's between here and {svc}.", 'mapping the route to {svc}.',
    'one moment, tracing {svc}.']);
  const pathLead = X(['', 'From the probe,', 'Right now,'], [
    '{svc} is about {ms} milliseconds away.', 'it takes about {ms} milliseconds to reach {svc}.', '{svc} is roughly {ms} milliseconds out.',
    'the round trip to {svc} is about {ms} milliseconds.', '{svc} answers in about {ms} milliseconds.', 'reaching {svc} takes around {ms} milliseconds.',
    '{svc} is {ms} milliseconds or so away.', "it's about {ms} milliseconds to {svc}.", '{svc} responds in roughly {ms} milliseconds.',
    'getting to {svc} takes about {ms} milliseconds.']);
  const pathSlow = X(['', 'That said,', 'Note that'], [
    'most of the delay comes in one jump{at}.', "there's one slow stretch{at}.", 'most of that time is spent on a single hop{at}.',
    'one hop{at} adds most of the delay.', 'the slow part is a single link{at}.', "there's a noticeable jump in delay{at}.",
    'one segment{at} is doing most of the slowing.', 'a single hop{at} accounts for most of it.', 'the path slows down sharply{at}.',
    "there's a bottleneck{at}."]);
  const pathLoss = X(['', 'Also,', 'One thing:'], [
    "there's some packet loss along the way{at}.", 'a few packets are getting lost{at}.', "there's a bit of loss on the path{at}.",
    "some packets aren't making it{at}.", 'the path is dropping a few packets{at}.', "there's packet loss showing up{at}.",
    "we're losing some packets{at}.", 'a little loss shows up{at}.', 'some of the traffic is being dropped{at}.', "there's a lossy hop{at}."]);
  const pathClean = X(['', 'Overall,', 'Good news:', 'Happily,', 'All in all,', 'So far,'], [
    'the path looks clean.', 'there are no problems along the way.', 'nothing looks wrong on the path.', "it's clean all the way there.",
    'every hop looks healthy.', "the route's in good shape.", 'no slow spots or loss along the way.', 'the whole path looks healthy.',
    "there's nothing to worry about on the route.", 'the trip there is smooth.']);
  const pathNoAnswer = X(['', 'Hmm,', 'Unfortunately,'], [
    "{svc} didn't answer the trace.", "the trace couldn't reach {svc}.", "there's no answer from {svc} on that trace.",
    "{svc} didn't respond to the trace.", 'the trace never got a reply from {svc}.', "we couldn't get through to {svc}.",
    '{svc} stayed silent on the trace.', 'the trace to {svc} came back empty.', 'no reply from {svc} this time.', "{svc} isn't answering traces."]);

  // ── Voice picker samples ────────────────────────────────────────────────
  const voiceHello = ["Hi, I'm {v}.", "Hello, this is {v}.", "Hey there, I'm {v}.", "{v} here.", "Hi! {v} speaking.",
    "Hello, I'm {v}. Nice to meet you.", "This is {v}.", "Hi there, {v} here.", "Hey, it's {v}.", "Good to meet you, I'm {v}."];
  const speedSample = X(['', 'Okay,', 'Alright,'], [
    'this is how fast I talk now.', 'is this a good pace?', "here's the new speed.", 'how does this pace sound?',
    "this is my new speaking speed.", "let me know if this is too fast or too slow.", "here's how I sound at this speed.",
    'this pace should be easy to follow.', "I'll talk at this speed from now on.", 'testing the new pace.']);

  window.PHRASES = {
    roomDown, roomSlow, roomFine,
    healthCalm, healthFew, healthBusy,
    worstActiveRepeat, worstActiveOne, worstPastRepeat, worstPastOne, restTail,
    overviewRoomFine, overviewRoomDown, overviewRoomSlow,
    headsUp, whatNetNow, whatAppNow, whatNetThen, whatAppThen, tappedActive, tappedCleared,
    pathStart, pathLead, pathSlow, pathLoss, pathClean, pathNoAnswer,
    voiceHello, speedSample,
  };
})();
