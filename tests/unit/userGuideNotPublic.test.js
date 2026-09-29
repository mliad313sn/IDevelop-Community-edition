'use strict';
/**
 * The standalone user guide must never be served without a session.
 *
 * What happened (UAT3 passe 2, finding P2-01, 2026-09-15): the guide was built
 * into `public/`, which `express.static` serves at server.js:145 - mounted
 * BEFORE the session middleware, so no authentication ever ran for it.
 * `GET /user-guide.html` with no cookie returned 200 and 5 035 421 bytes. The
 * document names real colleagues and quotes their 9-box box labels
 * ("Shooting Star", "Concern") in running text, and 108 embedded screenshots
 * carry names, staff numbers and roles where no text scanner can see them.
 * Measured against the live database: 23 ACTIVE employees named.
 *
 * Two things have to stay true, and only one of them is obvious:
 *   1. The file is NOT under public/ (the access fix).
 *   2. The route that hands it out requires authentication (the replacement).
 * Losing either one restores the leak in full, silently.
 *
 * This is a static test on purpose: it fails at build time, on a developer's
 * machine, before anything is packaged - the earlier failure shipped and was
 * deployed precisely because nothing checked the shape of the tree.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const GUIDES = ['user-guide.html', 'user-guide.en.html'];
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

describe('the guide is not in the publicly served tree', () => {
    test.each(GUIDES)('public/%s does not exist', (f) => {
        expect({ file: f, servedPublicly: fs.existsSync(path.join(ROOT, 'public', f)) }).toEqual({
            file: f,
            servedPublicly: false,
        });
    });

    test('the generator writes it outside public/', () => {
        const gen = read('scripts', 'build-user-guide.js');
        expect(gen).toMatch(/OUT_DIRS = \[path\.join\(ROOT, 'private', 'guides'\)/);
        expect(gen).not.toMatch(/OUT_DIRS = \[path\.join\(ROOT, 'public'\)/);
    });

    test('the generator removes a stale public copy instead of leaving it to win', () => {
        // express.static is mounted first, so a leftover file under public/
        // would be served ahead of the authenticated route - the leak back in
        // full, with the route sitting there looking correct.
        const gen = read('scripts', 'build-user-guide.js');
        expect(gen).toMatch(/path\.join\(ROOT, 'public', d\.file\)/);
        expect(gen).toMatch(/unlinkSync/);
    });
});

describe('an upgrade removes the copy that is already leaking', () => {
    // The installer copies with robocopy /E, never /MIR, so a file the product
    // stops shipping stays in the install directory for ever. Without an
    // explicit removal, upgrading a machine that is CURRENTLY serving the guide
    // anonymously would leave it serving the guide anonymously - and the
    // operator would reasonably believe the upgrade had closed it.
    const installer = () =>
        fs.readFileSync(path.join(ROOT, 'installer', 'Install-IDevelop.ps1'), 'utf8');

    test('both guide files are on the retired list', () => {
        const src = installer();
        const block = src.slice(src.indexOf('$retired = @('), src.indexOf('$retired = @(') + 1400);
        expect(block).toContain('public\\user-guide.html');
        expect(block).toContain('public\\user-guide.en.html');
    });

    test('the removal happens after the copy, or the copy would put it back', () => {
        const src = installer();
        expect(src.indexOf('robocopy $payload')).toBeLessThan(src.indexOf('$retired = @('));
    });

    test('it refuses a path that escapes the install directory', () => {
        expect(installer()).toMatch(/Refusing to remove a path outside the install directory/);
    });

    test('a failed removal is reported, not swallowed', () => {
        expect(installer()).toMatch(/COULD NOT remove retired file/);
    });
});

describe('the route that serves it demands a session', () => {
    const routes = () => read('src', 'routes', 'index.js');

    test('both URLs are declared, and behind requireAuth', () => {
        const src = routes();
        const block = src.slice(src.indexOf('GUIDE_FILES'), src.indexOf('GUIDE_FILES') + 1200);
        for (const f of GUIDES) expect(block).toContain(f);
        expect(block).toMatch(/router\.get\(Object\.keys\(GUIDE_FILES\), requireAuth/);
    });

    test('the file name comes from a fixed map, never from the request', () => {
        // A path assembled from req.params/req.path is a directory traversal
        // waiting to happen, on a route that reads from disk.
        const src = routes();
        const block = src.slice(src.indexOf('GUIDE_FILES'), src.indexOf('GUIDE_FILES') + 1200);
        expect(block).toMatch(/const file = GUIDE_FILES\[req\.path\]/);
        expect(block).toMatch(/if \(!file\) return res\.status\(404\)/);
        expect(block).toMatch(/'private', 'guides', file/);
    });
});

describe('the guide that ships is the one the reader is meant to see', () => {
    test('it still exists where the route looks for it', () => {
        for (const f of GUIDES) {
            const p = path.join(ROOT, 'private', 'guides', f);
            expect({ file: f, built: fs.existsSync(p) }).toEqual({ file: f, built: true });
        }
    });
});

/* ---------------------------------------------------------------------------
 * P2-01, CONTENT half. A separate defect from the access half above, and the
 * one an authenticated employee could still exercise after the route was fixed.
 *
 * What happened: the manual's examples had been written straight off the live
 * database. It named 23 ACTIVE colleagues in full, printed their staff numbers,
 * and put their 9-box cell in running text - "the manager approves a 9-box
 * (Shooting Star, box 8) on <a real colleague> (<their staff number>), role Data
 * Platform Lead. The platform immediately creates IDP #41". Those two labels are
 * NineBoxService.BOX_LABELS word for word. The person concerned had never been
 * told her placement: disclosed_at was NULL. Rule 17 of the rulebook puts the
 * confidentiality of a placement "on every path, without exception", and a
 * manual anyone can open is a path.
 *
 * WHY THIS GUARD WAS REBUILT ON 2026-09-15, on a suite that was already green.
 * The examples had been rewritten, and the roster below did exist - but it held
 * only "First Last" digests of six characters or more, so it was blind to three
 * shapes the manual actually uses:
 *   - "LAST, First"   the order the product's own lifecycle labels print, e.g.
 *                     a manager change rendered "<SURNAME>, <given name>";
 *   - a bare given name, as a screen greets you: "Welcome, <given name>";
 *   - a five-character staff number - ONB-3 was dismissed in an earlier comment
 *     here as "an onboarding placeholder, not an identity". It is the staff
 *     number of a real person on the owner's instance.
 * Measured that day, on documents this very file declared clean: the two built
 * guides named four real colleagues - one by given name twice over, two in full
 * in "LAST, First" order - and realIdentitiesIn() returned [] on both. The
 * roster is therefore built from FIVE shapes now, and every threshold below is
 * a measurement rather than an intuition.
 *
 * SECOND LESSON, cheaper and just as damaging: the source module had been
 * fixed and the documents had NOT been rebuilt. Source and artefacts are three
 * separate files; a guard that reads only the source certifies nothing about
 * what is served. Every check below runs over all three, and the cast is
 * asserted PRESENT in the built documents too, so a stale build fails here.
 *
 * HOW TO REGENERATE THE ROSTER when the workforce changes. Against each
 * database, development and the owner's instance:
 *   SELECT first_name, last_name, employee_number, username, email FROM employees;
 * then, for every row, digest each of:
 *   "first last" · "last first" · employee_number · username · email local part
 *   · every separate WORD of the given name and of the surname
 * with sha256(norm(value)).slice(0,12), keeping full names and word-parts of 5
 * normalised characters or more and identifiers of 5 or more. Digests, never
 * text: a denylist of real names spelled out would republish in the repository
 * exactly what was taken out of the manual.
 *
 * KNOWN LIMITS, stated rather than hidden.
 *   1. This reads text only. The guide also embeds screenshots as base64, and
 *      the pixels of 36 of them carried names, staff numbers and brand tokens
 *      that no scanner here can see. Those are pulled from the document
 *      (img: null, imgRetired: '<name>') and the last tests below check they
 *      stay pulled. The 64 that remain were opened and read by eye on
 *      2026-09-15 and carry no nominative data. A re-captured screenshot is
 *      trusted by eye, not by this suite - so re-capture on invented data.
 *   2. Anything under five normalised characters is not hunted: at that length
 *      a surname is indistinguishable from ordinary prose. A four-letter family
 *      name would pass, and only the full-name digests would catch it.
 *   3. A bare word allowed below is safe only because the full-name digests
 *      stand behind it: the invented "Landry PETROV" may keep its given name
 *      while any real person called Landry is still caught in full.
 * ------------------------------------------------------------------------- */
describe('the content names no real person', () => {
    const crypto = require('crypto');

    // Both digests and candidates go through this, or they never meet.
    const norm = (s) =>
        s
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .replace(/[‘’ʼ]/g, "'")
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();
    const digest = (s) => crypto.createHash('sha256').update(norm(s)).digest('hex').slice(0, 12);

    // 553 digests: for every row of the employee table of the development
    // database AND of the owner's instance - the full name in BOTH orders, the
    // staff number, the login, the e-mail local part, and every separate word
    // of the given name and of the surname. See the recipe above.
    const ROSTER = new Set(
        [
            '00006669fc15 001ab3a2c235 0031e578a5ed 00db0e3844a0 00e4242766a6 00f1169d141c 02440d0eab21 02b4662f26f2',
            '033b3d2fbea2 03421ab2e1ba 0460e3d39f90 04f16a8a230d 060d93b36516 067e1e18b94b 06e074dafde1 074eb4a7b5a7',
            '0864def3d218 08f49a129c4e 097477e63dc4 098bfa89ed89 09c5baad4174 09e4e1c19799 0a5b26a80b10 0a5d85bdbdae',
            '0b1087bf6524 0c5e41e0a277 0c6a1b6ee44f 0d5ba1afce76 0d6bd0f3149a 0d7e5f662219 0e8ef2287898 0f27e7b97cde',
            '0f3a392f3cad 0f66c50f2e3e 0fc98b6b0f81 102f327d4ae6 1074d1ca65f8 10d83f2b0b08 110cc34a7c1b 1160130875fd',
            '118c58598386 124cf06235dc 144cfc088002 14a92f485133 152fc4dddced 1693a58510de 169ef4b2b897 16b36be8c541',
            '18959e690ce3 18fe3de09303 19a512f0128f 19d51f3acc5c 19d7b9bb6ab8 19edf9aacf5e 19faffab3fc2 1a827203214f',
            '1aa5e78265a3 1ac44cfda27c 1b02fb7383fc 1b3e5bfe72b6 1bcb1c994811 1bfd044790b8 1c9ea98a2dbe 1cb83c8eb93f',
            '1cbfb6600753 1d83be3c528a 1da4f96bf718 1dca23043d6c 1dd9fb612aac 1de45a05c945 1eb7a9f2e210 1ed496df447b',
            '1f7d8737f70b 1f86ca19d765 1fd6227a4652 2034a3c1a445 2209705e8521 227da60ebd1a 22f58267d1e0 2409aad268e6',
            '24b00a905b0e 250c919f0645 250dfe269671 25e4c28f7e6b 261b9c6f5fbc 26c3d6758723 273cad333879 27e2e44c2416',
            '28182f0a2781 286a6ed6b224 289e8017c7a1 28d9fd1643bd 29578ef69d45 2ab98f361a96 2acd0ea03922 2b54c231a7fd',
            '2c15a19705d8 2c15a99b4587 2c7545a7dde9 2c811743b158 2cdf8318978d 2da813f513b5 2ddd206ee49c 2ddfb7191e3b',
            '2ebde0d346c7 2f54855da693 2fa8864ffb35 2fc1c9ec3f31 30468a58c8e3 30b238fe1fc9 30e2419fc2d7 3112f039721d',
            '3151a9c20807 31d25f408265 32669cbad731 327c081dbc4b 32877492ed3f 3287a1551330 331fd79ac620 3374ee5b9e14',
            '341cc65fa8eb 34657345635c 34b824935994 352300032cab 35ba802faf08 36cdfcec47d2 38069fc2a161 386e512886dc',
            '387a141a2e75 38b1d14a70a1 39b9e5c3d0f1 3a531f421a27 3b8c276dd1c4 3be605eb8aa0 3cdf5ea53216 3d6e30be2e04',
            '3d9047f1f4e3 3da118db7a24 3de912f43cb4 3e99be372a6f 3eef400f2316 3f229c79d8dd 3f6c3f9282fc 3f910ac519df',
            '3fbcedfe0773 40a0e60052e8 40a29f0e5852 41ab52ddec23 4239ad3378e8 426c82aec062 42920c52ae80 42a30c48aa98',
            '433131c5e1c6 43d0ca2339c6 43e483b1a362 441085308465 4429691b79c5 44ab29480cd4 451306a02a12 4550c880b656',
            '46010802c10e 46343370964d 465362d75411 46a752d257bb 47a18f83daff 47d2528327aa 47dd747bab68 47e479c6326c',
            '48782bd1cb75 4a1b2d9ac89f 4b9c21d24f78 4bdecf0b75b2 4c022d984d15 4c71dd39b5a4 4e5c1c6e6658 4e66bf88995f',
            '4f215ebd919d 4f2e47751d11 4fefb3f269fc 5019ed7c66b9 509cd63f1969 50efabae5625 5109d584e4f6 519c511975be',
            '51edd6445b0b 526d7bac1ca3 5272a7b7e14f 528587a061eb 54103e7e7718 544af2e457b2 5459617f5ef6 54fe13b60f4c',
            '550e7a0497fb 5564d0eeb0c7 573a49dec718 575e500ddb52 575e5d3fa3df 57fd937d1452 5812657ab97a 58229a764cb0',
            '584dd29d619e 585977cfbd60 58ce13f19562 59036e058492 5996e2187dc1 59ea185e96c9 5a22dd4e8459 5a2afccb8646',
            '5a77ca2e9163 5aaac5589673 5b39bfccb144 5bb589f2035b 5bc32f82bb33 5bcbcbebee38 5bdece425f52 5e8d76ad8bc5',
            '5f09548e4a25 5f2f1d6482e6 6067700c069c 606f64168c8d 607dd2656e3d 6130d2c985c3 629e615a82a2 63a3380d34a0',
            '642111bea00b 64401696a3a5 6498a2c301b4 65462215e7f5 65eb6830fe80 67397d0bd6d5 67ce2ac908b6 67ce714bc04d',
            '67eac5909e8e 688301f9495f 68f675de581d 69cecde61156 6a34912288e3 6b946e655018 6c23b8ad3a04 6ccd348eea22',
            '6e4977be9875 6e5a231d0214 6e6931adfb3e 6f4d2c29174e 6fa100413aef 7004b75be6d9 70a5f8c878d5 7132fe635f6e',
            '715696dd517a 7162898bede6 719cacb41eca 725433470a0e 7260a6f7e157 727dce55d704 72f4ad036f7c 737a8dd018b8',
            '739b5f6aa67e 73ec81fd90c6 742b9bb2306e 748d3d540772 74e1d2224eb4 7548be747159 75859fe56fdd 76581b39d17d',
            '76bba1157d46 7722ec6ebb12 7834b9ded32d 784a0b13601d 78b798b911a1 79f81ef81ad8 7a8bb1db0e81 7b85175b4550',
            '7b9d9c442dc8 7bd8472ef342 7becaf4d590a 7c83b7abb907 7e091bd5a189 7ebeabfae77d 7eeccafa2c38 7eedaa36b223',
            '7f62af359652 7f9414c232cd 7f9dbc745abd 8009379472c6 8097a40d0018 80a6b981b2f6 81c5809aaa47 81e090666535',
            '8284e8f30f2f 8285114a5b7f 838d3d81837d 83981196e6d0 839c1bc7d195 83b5e7ffd0f5 84c401af02ca 85115569fffa',
            '852a2d3b875c 85cb3daccfa0 86de128a2ae0 885bd2e9d9d4 8957d8ed2771 8a2a2b9979ba 8b06bf530e72 8b9200b2cd16',
            '8c2e8f1f3549 8c4ac2329458 8eb710c1df9b 8ed3f6ad685b 904294d8c54b 909948426e87 90be0995aa2c 90f2fa017b1a',
            '90f8174a0679 9124e29e0c92 9177a6fbbd94 91d064dd366b 927bc09646a8 93bcab290fc3 942b7d9dd582 94fb6db90ea3',
            '954d3a426a1d 95876d20da1d 960f02e4e67c 9637fe2f300f 96558d4a6a2b 974394ae2620 976d597cad26 980aa5d8e8f0',
            '98d6cd074304 9990ff750a8e 99a4144069dd 99d336dfe1d8 9a61cefa26dd 9aa585485fff 9ac3822e21cb 9b243851256c',
            '9d7dff612955 9dd9568e9af8 9eb6e3170b79 9ebcd46db8ce 9ed9ff61664d 9f55ff82da39 a01d7e442e0e a1f1b2ed3c3c',
            'a24361eff244 a49435f667b0 a4ec7ce015c0 a5bcffe6eb81 a66da87f8d52 a6ad8a7c6290 a6b28ecdd66e a6cd9f5b2eff',
            'a72289cfe2dd a72ee62b1aba a785d7d99a9e a7960de5e913 a7e68904a577 a925934d282c a99cd109c464 aa2cd80e519c',
            'aa706b3ce229 aab7cd9512b7 ab23bcf11591 ab569bdb3cd7 acfba0fb3c04 adb550f08a73 adfafdc089da af634bf304c0',
            'b01fc003e4c8 b0ddb428514f b1129a0a697d b1324cbfbe08 b1505d3a84a5 b153845ce8fe b163ee40e727 b16aad885854',
            'b17e060eb858 b1a72a689dd8 b1d849a7626a b2182d8d48e3 b352ced811c2 b39281e4a427 b3c899be98b1 b4420f01ef0e',
            'b54d3711883e b57105b5f20a b5ebb916ac6b b61d0d7504e0 b9aec4ad8290 b9fc4c7b874a ba5d0ef283db baf824966552',
            'bb66f424310d bba367849216 bc0fbf003c1f bc6297251568 bc7313ece378 bc88c7f18226 bdb2fddfca28 bdd84d21ea82',
            'be879f7549cc bf26be9247c7 bf655ca47edb bf74e4a280af bf9388c2839e bfd5aeca1b2c bfda56a3db5b bfe601ebe9c1',
            'c002616cb6e1 c0aa615ae33e c189a8253084 c199de6dd201 c263c098af64 c2708a6ac35d c33ef89fccbe c408232e696b',
            'c421160cd00c c4811e6ea609 c566b39b1042 c57b269f5faf c5d0be24441f c638dee8f1db c641fa54aaf5 c65186832285',
            'c6524b2f6f15 c70e437c08f6 c732481da602 c75bbf19b778 c8e46005892a c8ff295bf190 ca68c91636f5 cab2f071c6d4',
            'cae967dc828e cae98e77087c caf207fc1960 cb44fa35a417 cba77a3115aa ccb049c61657 cd0f363d9e78 ce4c99007c0a',
            'ce724062a8de ce9959f60d19 cee69396a8de cf17a710018d d0a102861619 d0d74c92facb d0eb28073a78 d0f5b7514236',
            'd14244a0dbfc d151e68ab9ac d1aee78ea247 d1d32114f7cd d233633d9524 d38681074467 d3932af6ee06 d421357abd93',
            'd4b435019f67 d53b5304d5f2 d5a5d66b94e8 d5e2b356d574 d6cc33a6e209 d6e2eaf694ff d77c20da8a79 d7c223ae6b9f',
            'd857f0f1b2a0 d8c64ebe46f1 d8f972ab00d9 d9504e6a4fd7 da3573850ea5 db879fce70f9 dbf28ca4f88d dc2283165495',
            'dc5297aa661d dc52e2bb2668 dc8fc06cc4ae dc96aa10dee5 dd1b1ddcf6b0 dd1b884e6a8a dd477a58bb5e dd4a3f2c4d51',
            'dd9b998e9d81 de19933ad2d9 de5c91cac454 de5f05ac4f45 de9a1cb00004 df50d7e60467 df59c257785d e1fe3252fba9',
            'e2348ae419dc e2be9b65caa0 e45a8c5ead19 e47180296c29 e4cfdf4dc87f e59061a9dfef e5dc127f9f0a e5e6ac1b982a',
            'e82845f99f0d e83ec143f63f e8452cb856d1 e8d52c941124 e958ca54588c e98edba5c48e e9a46abc1bf5 ea15a1bddbc4',
            'eae0dfa6e8d7 ebaf06e2e3ad ec6c28e78338 ed7e64b31cba ed9ee263bd9b ee08ae663ab5 ee8b09fedd27 ef441365f38a',
            'efa971bc22d4 efbeedfa6539 f1599d66bc45 f1e7da479506 f2dfa5fc64f9 f333c6abd372 f3c9d981cb61 f3cd64e500ce',
            'f42ad0cff7bc f487587702ce f4af10ee0866 f4d776c2a0a1 f57090c93ba6 f58673fb7d8d f5dfc4d0cc46 f6a9a3a28a18',
            'f75d698dc5a6 f786c9a08eca f7d0ca14a5a6 f7e471e0ab31 f8462f5a293f f8c203eb22ad f919e917dd9b f94e29b0dfaf',
            'f9c595c1d299 f9d1137d3bf4 f9d52df87ef6 f9f2811ebe68 fa86faf354f4 fb60bef701cd fb7cdf5209d9 fb95c765bac8',
            'fbffb5404582 fc81a55fbee2 fca1d133f81f fdf31acb3970 fec137a3cd09 fed61249acd3 fee9c0a0cd6b feff1367d017',
            'ffea4ba2f146',
        ]
            .join(' ')
            .split(' ')
    );

    // Ordinary words the roster collides with, MEASURED against the three
    // artefacts on 2026-09-15 - not guessed, and not a place to silence a real
    // finding. Each is safe only because the full-name digests stand behind it
    // (see limit 3 above). Adding an entry here is an admission that a real
    // surname is also a common word. It can only ever excuse a SINGLE word:
    // the matcher below refuses to honour an allowance that contains a space,
    // so no amount of editing this list can hide a full identity.
    const ALLOWED = new Set(
        [
            'landry', // the invented "Landry PETROV"; a real colleague shares the surname
            'erased', // the invented leaver "ERASED-90010 / Erased 90010", and the English verb
        ].map(norm)
    );

    // base64 payloads are not prose: hashing windows of them would burn minutes
    // and find nothing, because the text scanner is blind to pixels anyway.
    const textOf = (s) => s.replace(/data:image\/[a-z+]*;base64,[A-Za-z0-9+/=]+/g, ' ');
    // A token is what a name or a staff number is made of: letters, digits,
    // apostrophes, hyphens. "O'Brien", "Jean-Luc" and "EMP-1770766763427-974"
    // each stay whole - and so does "ONB-3", which is why the floor is 5.
    const TOKEN = /[A-Za-zÀ-ɏ0-9][A-Za-zÀ-ɏ0-9'’-]*/g;
    const MIN = 5;

    /** Every real identity this text contains, or an empty array. */
    function realIdentitiesIn(text) {
        const tokens = textOf(text).match(TOKEN) || [];
        const found = new Set();
        for (let i = 0; i < tokens.length; i++) {
            for (let n = 1; n <= 5 && i + n <= tokens.length; n++) {
                const candidate = tokens.slice(i, i + n).join(' ');
                const key = norm(candidate);
                if (key.length < MIN) continue;
                // An allowance excuses one ordinary word, never an identity.
                if (!key.includes(' ') && ALLOWED.has(key)) continue;
                if (ROSTER.has(digest(candidate))) found.add(candidate);
            }
        }
        return [...found];
    }

    const SUBJECTS = [
        ['src/config/userGuideContent.js', () => read('src', 'config', 'userGuideContent.js')],
        ['private/guides/user-guide.html', () => read('private', 'guides', 'user-guide.html')],
        [
            'private/guides/user-guide.en.html',
            () => read('private', 'guides', 'user-guide.en.html'),
        ],
    ];

    test.each(SUBJECTS)(
        '%s holds no name or staff number from the employee table',
        (label, load) => {
            // The names are printed on failure on purpose: the person fixing it has
            // to see WHICH example to rewrite, and by then they are already in the
            // file. Nothing is written to the repository by a passing run.
            expect({ file: label, realPeopleNamed: realIdentitiesIn(load()) }).toEqual({
                file: label,
                realPeopleNamed: [],
            });
        }
    );

    // The invented cast, asserted PRESENT in all three artefacts.
    // Two things at once, and the second is the one that was missed:
    //   - a guide emptied of its worked examples would pass the test above
    //     trivially; the fix was to replace the people, not delete the teaching;
    //   - a source that has been rewritten and NOT rebuilt leaves the old names
    //     in the documents that are actually served. On 2026-09-15 the module
    //     was 40 minutes newer than the guides and the guides still named four
    //     colleagues. Asserting the cast in the BUILT files is what turns that
    //     from an invisible state into a red test.
    const CAST = [
        'Norah HARTLEY',
        'Aïcha FARRELL',
        'Zoumana WALSH',
        'Souleymane LARSÈN',
        'Yao HALVORSEN',
    ];
    test.each(SUBJECTS)(
        '%s carries the invented cast, so an empty or stale artefact fails',
        (label, load) => {
            const src = load();
            expect({ file: label, missing: CAST.filter((c) => !src.includes(c)) }).toEqual({
                file: label,
                missing: [],
            });
        }
    );

    test('the notice that the people are invented is printed in both languages', () => {
        const src = read('src', 'config', 'userGuideContent.js');
        expect(src).toMatch(/personnes citées sont fictives/); // FR
        expect(src).toMatch(/people it names are invented/); // EN
    });

    // Identifiers are identities too, and they are the half that slips through
    // a reader's eye. ONB-3 sat in the manual as "the employee is born with
    // number ONB-3" and is the staff number of a real person on the owner's
    // instance; an earlier comment in this very file had dismissed it as a
    // placeholder. Invented numbers are pinned present, the real one absent.
    test.each(SUBJECTS)('%s quotes invented identifiers, never a live one', (label, load) => {
        const src = load();
        const report = {
            file: label,
            inventedOnboardingNumber: src.includes('ONB-90003'),
            inventedLeaverRecord: src.includes('ERASED-90010'),
            liveOnboardingNumber: /\bONB-3\b/.test(textOf(src)),
            liveErasedRecordId: /\bERASED-68963\b/.test(textOf(src)),
        };
        expect(report).toEqual({
            file: label,
            inventedOnboardingNumber: true,
            inventedLeaverRecord: true,
            liveOnboardingNumber: false,
            liveErasedRecordId: false,
        });
    });

    // The 36 screenshots withdrawn on 2026-09-15 because their PIXELS carry what
    // the text checks above cannot see: colleagues by name, staff number, role,
    // 9-box status and readiness (the roster, matrix, org chart, gap analysis,
    // employee records...), the live instance's privileged accounts with their
    // MFA state and an address carrying the customer's name, and three screens
    // with the customer / internal brand token burnt into the image.
    //
    // This list is FROZEN on purpose. Deriving "what is retired" from the file
    // itself would let someone flip one card back to `img:` and still pass - an
    // earlier version of this test did exactly that, and a mutation run caught
    // it staying green. Removing an entry here is therefore a deliberate act,
    // and it is only legitimate once the shot has been RE-TAKEN on invented data.
    const RETIRED = [
        'emp-01-dashboard',
        'emp-13-account',
        'sup-sv-05-gap-analysis',
        'sup-sv-06-coaching',
        'sup-sv-10-nine-box',
        'mgr-02c-sa-reviews-detail',
        'mgr-03-gap-analysis',
        'mgr-04-dashboard-executive',
        'mgr-07-readiness-report',
        'mgr-10-nine-box-roster',
        'mgr-13-career-path-analysis',
        'mgr-15-coaching',
        'mgr-19-continuity',
        'mgr-20-qualified-lookup',
        'mgr-23-movements-365',
        'mgr-26-employees',
        'mgr-27-skill-matrix',
        'mgr-29-org-chart',
        'mgr-30-lifecycle',
        'mgr-32-employee-profile',
        'mgr-35-benchmark-role-detail',
        'mgr-37-employee-progression',
        'sup-mgr-10-nine-box',
        'la-02-employees',
        'sa-02-employees',
        'sa-17-system-logs',
        'sa-18-admin-sessions',
        'sa-21-reports-readiness',
        'sa-24-compliance',
        'sa-51-employee-edit-credentials',
        'sa-56-employee-profile',
        'sa-12-admins',
        'sa-13-access-review',
        'sa-42-report-templates',
        'sa-54-about',
        'sa-55-setup',
    ];

    test.each(RETIRED)('%s stays withdrawn from the content model', (name) => {
        const content = read('src', 'config', 'userGuideContent.js');
        expect({ shot: name, stillRetired: content.includes(`imgRetired: '${name}'`) }).toEqual({
            shot: name,
            stillRetired: true,
        });
        // and it must not be referenced as a live image anywhere else
        expect(content).not.toContain(`img: '${name}'`);
    });

    test('a screenshot pulled for showing real people is never rendered again', () => {
        // imgRetired is a to-do, not a source. If the generator ever resolved it
        // the pixels - names, staff numbers, the customer's mail domain - would
        // come straight back inside base64, where nothing above can see them.
        const content = read('src', 'config', 'userGuideContent.js');
        const retired = [...content.matchAll(/imgRetired: '([^']+)'/g)].map((m) => m[1]);
        expect([...new Set(retired)].sort()).toEqual([...RETIRED].sort());

        const gen = read('scripts', 'build-user-guide.js');
        expect(gen).not.toMatch(/pic\(\s*f\.imgRetired/);

        // Beside every imgRetired, img must be null on the SAME card.
        const cards = [...content.matchAll(/img: ([^,]+),\s*imgRetired: '([^']+)'/g)];
        expect(cards.map(([, img]) => img)).toEqual(retired.map(() => 'null'));

        // And the documents that actually ship must not name them either.
        for (const f of GUIDES) {
            const built = read('private', 'guides', f);
            for (const name of RETIRED) expect(built).not.toContain(name);
        }
    });
});
