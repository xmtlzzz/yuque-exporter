import path from 'path';
import PQueue from 'p-queue';
import yaml from 'yaml';
import fg from 'fast-glob';

import { SDK } from './sdk.js';
import { logger, writeFile, rm, readJSON } from './utils.js';
import { config } from '../config.js';
const { host, token, userAgent, clean, metaDir } = config;

const sdk = new SDK({ token, host, userAgent });
const taskQueue = new PQueue({ concurrency: 10 });

export async function crawl(inputs?: string[]) {
  logger.info('Start crawling...');
  if (clean) await rm(metaDir);

  // if inputs is empty, crawl all repos of the user which associated with the token
  if (!inputs || inputs.length === 0) inputs = [ '' ];

  // find target repos
  const repoList = new Set<string>();
  for (const input of inputs) {
    const [ user, repo, extra ] = input.split('/');
    if (extra) {
      logger.warn(`invalid url paths: ${input}`);
      continue;
    } else if (repo) {
      // fetch a repo with namespace
      repoList.add(`${user}/${repo}`);
    } else {
      const userInfo = await sdk.getUser(user);
      const login = userInfo.login;
      await saveToStorage(`${login}/user.json`, userInfo);

      // fetch all repos with user name
      const repos = await sdk.getRepos(login);
      await saveToStorage(`${login}/repos.json`, repos);
      for (const repo of repos) {
        if (repo.type === 'Book') {
          repoList.add(repo.namespace);
        }
      }
    }
  }
  logger.info(`Find repos to crawl: ${[ '', ...repoList ].join('\n  - ')}\n`);

  // crawl repos
  for (const namespace of repoList) {
    await crawlRepo(namespace);
  }
}

export async function crawlRepo(namespace: string) {
  // crawl repo detail/docs/toc
  logger.success(`Crawling repo detail: ${host}/${namespace}`);
  const repo = await sdk.getRepoDetail(namespace);
  const toc = yaml.parse(repo.toc_yml);
  const docList = await sdk.getDocs(namespace);
  const docsPublishedAtKey = 'docs-published-at';

  await saveToStorage(`${namespace}/repo.json`, repo);
  await saveToStorage(`${namespace}/toc.json`, toc);
  await saveToStorage(`${namespace}/docs.json`, docList);

  // detect changed docs BEFORE writing docs-published-at.json to avoid false-positive "already crawled"
  const oldDocsPublishedAtPath = await fg(`${namespace}/docs-published-at.json`, { cwd: metaDir, deep: 2 });
  const oldDocsPublishedAtMap: Record<number, string> = oldDocsPublishedAtPath.length
    ? await readJSON(path.join(metaDir, oldDocsPublishedAtPath[0]))
    : {};
  const docChangedList = docList
    .filter(doc => typeof oldDocsPublishedAtMap[doc.id] === 'undefined' || oldDocsPublishedAtMap[doc.id] !== doc.published_at);

  // save updated docs-published-at first, so on next run we correctly detect unchanged docs
  await saveToStorage(`${namespace}/docs-published-at.json`, Object.fromEntries(
    [ ...docList.entries() ].map(([ , doc ]) => [ doc.id, doc.published_at ]),
  ));

  let docs = [];
  if (docChangedList.length) {
    docs = await taskQueue.addAll(docChangedList.map(doc => {
      return async () => {
        logger.success(` - [${doc.title}](${host}/${namespace}/${doc.slug})`);
        const docDetail = await sdk.getDocDetail(namespace, doc.slug);
        await saveToStorage(`${namespace}/docs/${doc.slug}.json`, docDetail);
      };
    }));
  } else {
    logger.info('Stop crawling, nothing new');
  }

  logger.log('');

  return { repo, toc, docList, docs };
}

async function saveToStorage(filePath: string, content) {
  await writeFile(path.join(metaDir, filePath), content);
}
