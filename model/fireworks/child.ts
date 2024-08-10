import { ComChild, DestroyOptions } from '../../utils/pool';
import { Account, extractSecretKey, getFireworksModel } from './define';
import {
  CreateNewAxios,
  CreateNewPage,
  getProxy,
} from '../../utils/proxyAgent';
import { Page } from 'puppeteer';
import moment from 'moment';
import { loginGoogle } from '../../utils/puppeteer';
import { ErrorData, Event, EventStream, parseJSON, sleep } from '../../utils';
import es from 'event-stream';
import { AxiosInstance } from 'axios';
import { Stream } from 'stream';
import { getModelConfig } from '../poe/define';
import { ModelType } from '../base';

export class Child extends ComChild<Account> {
  private client!: AxiosInstance;
  private page!: Page;
  private apipage!: Page;
  private proxy: string = this.info.proxy || getProxy();
  private updateTimer: NodeJS.Timeout | null = null;

  async saveCookies() {
    const cookies = await this.page.cookies();
    this.update({ cookies });
    this.logger.info('cookies saved ok');
  }

  async saveUA() {
    const ua = await this.page.evaluate(() => navigator.userAgent.toString());
    this.update({ ua });
  }

  async saveAPIKey() {
    await this.page.goto('https://fireworks.ai/account/api-keys');
    const v = await this.page.evaluate(() => {
      return Array.from(document.scripts)
        .map((v) => v.textContent)
        .find((v) => v && v.indexOf('plaintext') > -1);
    });
    if (!v) {
      throw new Error('no apikey script');
    }
    const apikey = extractSecretKey(v);
    if (!apikey) {
      throw new Error('apikey not found');
    }
    this.update({ apikey });
    this.logger.info('apikey saved ok');
  }

  async checkChat() {
    const pt = new EventStream();
    const model = getFireworksModel(ModelType.Llama3_1_8b);
    await new Promise(async (resolve, reject) => {
      try {
        await this.askForStream(
          {
            model: model.id,
            messages: [
              {
                role: 'user',
                content: 'say 1',
              },
            ],
            temperature: 0.1,
            max_tokens: 2,
            top_p: 1,
            stream: true,
          },
          pt,
        );
        pt.read(
          (event, data) => {
            if (event === Event.error) {
              reject(new Error((data as ErrorData).error));
            }
            if (event === Event.done) {
              resolve(null);
            }
          },
          () => {
            resolve(null);
          },
        );
      } catch (e) {
        reject(e);
      }
    });
    this.logger.info('check chat ok');
  }

  async askForStream(req: any, stream: EventStream) {
    try {
      const res = await this.client.post<Stream>('/v1/chat/completions', req, {
        responseType: 'stream',
      });
      res.data.pipe(es.split(/\r?\n\r?\n/)).pipe(
        es.map(async (chunk: any, cb: any) => {
          const dataStr = chunk.replace('data: ', '');
          if (!dataStr) {
            return;
          }
          if (dataStr === '[DONE]') {
            return;
          }
          const data = parseJSON(dataStr, {} as any);
          if (!data?.choices) {
            stream.write(Event.error, { error: 'not found data.choices' });
            stream.end();
            return;
          }
          const choices = data.choices || [];
          const { delta, finish_reason } = choices[0] || {};
          if (finish_reason === 'stop') {
            return;
          }
          if (delta) {
            stream.write(Event.message, delta);
          }
        }),
      );
      res.data.on('close', () => {
        stream.write(Event.done, { content: '' });
        stream.end();
      });
    } catch (e: any) {
      if (e.message.indexOf('restricted') > -1) {
        this.logger.info('org restricted');
        this.update({ refresh_time: moment().add(30, 'day').unix() });
        this.destroy({ delFile: false, delMem: true });
        throw e;
      }
      throw e;
    }
  }

  async init() {
    if (!this.info.email) {
      throw new Error('email is required');
    }
    this.update({ destroyed: false });
    let page;
    if (!this.info.cookies?.length) {
      page = await CreateNewPage('https://fireworks.ai/login', {
        proxy: this.proxy,
      });
      this.page = page;
      // click login
      await page.waitForSelector("button[type='submit']");
      await page.click("button[type='submit']");

      await loginGoogle(
        page,
        this.info.email,
        this.info.password,
        this.info.recovery,
      );
    } else {
      page = await CreateNewPage('https://fireworks.ai', {
        proxy: this.proxy,
        cookies: this.info.cookies.map((v) => ({
          ...v,
          url: 'https://fireworks.ai/',
        })),
      });
      this.page = page;
    }
    await sleep(3000);
    this.update({ proxy: this.proxy });
    await this.saveUA();
    await this.saveCookies();
    await this.saveAPIKey();
    this.client = CreateNewAxios(
      {
        baseURL: 'https://api.fireworks.ai/inference',
        headers: {
          accept: 'text/event-stream',
          'accept-language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7,en-GB;q=0.6',
          authorization: `Bearer ${this.info.apikey}`,
          origin: 'https://fireworks.ai',
          priority: 'u=1, i',
          'user-agent': this.info.ua,
          'content-type': 'application/json',
        },
      },
      { proxy: this.proxy },
    );
    await this.checkChat();
  }

  initFailed() {
    this.update({ cookies: [], proxy: undefined });
    this.destroy({ delFile: false, delMem: true });
  }

  use() {
    this.update({
      lastUseTime: moment().unix(),
      useCount: (this.info.useCount || 0) + 1,
    });
  }

  destroy(options?: DestroyOptions) {
    super.destroy(options);
    this.page
      ?.browser()
      .close()
      .catch((err) => this.logger.error(err.message));
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }
  }
}
