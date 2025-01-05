import * as puppeteer from 'puppeteer-core';

import { execSync } from 'child_process';
import winston from 'winston';

// 配置日志记录器
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console()
    ]
});

// 获取 Chrome 可执行文件路径
function getChromePath(): string {
    try {
        // macOS 上常见的 Chrome 路径
        const paths = [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
            '/Applications/Chromium.app/Contents/MacOS/Chromium'
        ];

        for (const path of paths) {
            try {
                execSync(`test -f "${path}"`);
                return path;
            } catch {
                continue;
            }
        }

        throw new Error('找不到 Chrome 可执行文件');
    } catch (error) {
        logger.error('获取 Chrome 路径失败:', error);
        throw error;
    }
}

interface RegistrationConfig {
    emails: string[];
    password: string;
    registrationUrl: string;
}

export class CodeiumRegistration {
    private config: RegistrationConfig;
    private browser: puppeteer.Browser | null = null;
    private retryCount = 0;
    private readonly maxRetries = 3;
    private readonly chromePath: string;

    constructor(config: RegistrationConfig) {
        this.config = config;
        this.chromePath = getChromePath();
        logger.info(`Chrome 路径已配置: ${this.chromePath}`);
    }

    private async initBrowser(): Promise<boolean> {
        if (this.browser) {
            return true;
        }

        try {
            this.browser = await this.retryLaunchBrowser();
            return this.browser !== null;
        } catch (error) {
            logger.error('浏览器初始化失败:', error);
            return false;
        }
    }

    private async retryLaunchBrowser(): Promise<puppeteer.Browser | null> {
        while (this.retryCount < this.maxRetries) {
            try {
                logger.info(`尝试启动浏览器 (尝试 ${this.retryCount + 1}/${this.maxRetries})`);
                
                const browser = await puppeteer.launch({
                    executablePath: this.chromePath,
                    headless: false,
                    defaultViewport: { width: 1280, height: 800 },
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--disable-gpu',
                        '--window-size=1280,800',
                        '--remote-debugging-port=0'
                    ]
                });

                // 测试浏览器连接
                const pages = await browser.pages();
                await pages[0].goto('about:blank');

                logger.info('浏览器启动成功');
                return browser;
            } catch (error) {
                logger.error(`浏览器启动尝试 ${this.retryCount + 1} 失败:`, error);
                this.retryCount++;
                
                if (this.retryCount < this.maxRetries) {
                    const delay = 5000 * this.retryCount;
                    logger.info(`等待 ${delay}ms 后重试...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        return null;
    }

    async registerAccount(email: string): Promise<boolean> {
        if (!await this.initBrowser()) {
            throw new Error('无法初始化浏览器');
        }

        if (!this.browser) {
            throw new Error('浏览器未初始化');
        }

        let page: puppeteer.Page | null = null;
        try {
            page = await this.browser.newPage();
            await page.setDefaultNavigationTimeout(30000);
            await page.setDefaultTimeout(30000);

            // 设置用户代理
            await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

            logger.info(`尝试注册账户: ${email}`);
            
            // 导航到注册页面
            await page.goto(this.config.registrationUrl, {
                waitUntil: 'networkidle0',
                timeout: 30000
            });

            // 等待页面加载完成
            await page.waitForSelector('input[name="email"]', { timeout: 10000 });
            await page.waitForTimeout(1000); // 等待页面完全加载

            // 填写邮箱
            const emailInput = await page.$('input[name="email"]');
            if (!emailInput) {
                throw new Error('邮箱输入框未找到');
            }
            await emailInput.type(email, { delay: 100 });
            await page.waitForTimeout(500);

            // 找到密码输入框
            const passwordInput = await page.$('input[name="password"]');
            const confirmPasswordInput = await page.$('input[name="confirmPassword"]');
            
            if (!passwordInput || !confirmPasswordInput) {
                throw new Error('密码输入框未找到');
            }

            // 填写密码和确认密码
            await passwordInput.type(this.config.password, { delay: 100 });
            await page.waitForTimeout(500);
            await confirmPasswordInput.type(this.config.password, { delay: 100 });
            await page.waitForTimeout(500);

            // 勾选同意条款复选框
            const checkbox = await page.$('#termsAccepted');
            if (!checkbox) {
                throw new Error('同意条款复选框未找到');
            }
            await checkbox.click();
            await page.waitForTimeout(500);

            // 等待按钮变为可点击状态并点击
            await page.waitForSelector('button.font-semibold.flex:not([disabled])', { timeout: 15000 });
            
            // 确保在点击前等待一下
            await page.waitForTimeout(1000);

            // 直接点击按钮
            await page.click('button.font-semibold.flex:not([disabled])');

            // 等待导航完成
            await page.waitForNavigation({ 
                waitUntil: ['networkidle0', 'domcontentloaded'],
                timeout: 30000 
            });

            // 检查是否注册成功
            const currentUrl = page.url();
            if (currentUrl.includes('register')) {
                throw new Error('注册失败: 仍在注册页面');
            }

            logger.info(`账户 ${email} 注册成功`);
            return true;

        } catch (error: any) {
            const errorMessage = error.message || '未知错误';
            logger.error(`注册账户 ${email} 失败: ${errorMessage}`);

            // 保存错误截图
            if (page) {
                try {
                    const fs = require('fs');
                    const path = require('path');
                    
                    // 确保screenshots目录存在
                    const screenshotsDir = path.join(__dirname, '../screenshots');
                    if (!fs.existsSync(screenshotsDir)) {
                        fs.mkdirSync(screenshotsDir, { recursive: true });
                    }
                    
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    const screenshotPath = path.join(screenshotsDir, `error-${timestamp}.png`);
                    
                    await page.screenshot({ 
                        path: screenshotPath,
                        fullPage: true 
                    });
                    logger.info(`错误截图已保存: screenshots/error-${timestamp}.png`);
                } catch (screenshotError: any) {
                    logger.error('保存错误截图失败:', screenshotError.message);
                }
            }
            throw error; // 重新抛出错误，让调用者处理
        } finally {
            // 关闭页面
            try {
                await page?.close();
            } catch (error: any) {
                logger.error('关闭页面失败:', error.message);
            }
        }
    }

    /**
     * 批量注册所有账户
     */
    async registerAll(): Promise<void> {
        try {
            logger.info('开始批量注册账户');
            
            for (const email of this.config.emails) {
                // 添加随机延迟，避免请求过于频繁
                const delay = Math.floor(Math.random() * 3000) + 3000;
                await new Promise(resolve => setTimeout(resolve, delay));
                
                try {
                    await this.registerAccount(email);
                    logger.info(`账户 ${email} 注册成功`);
                } catch (error: any) {  
                    const errorMessage = error.message || '未知错误';
                    logger.error(`注册账户 ${email} 失败: ${errorMessage}`);
                    logger.warn('注册失败，继续下一个账户...');
                }
            }
        } finally {
            await this.cleanup();
        }
    }

    async cleanup(): Promise<void> {
        if (this.browser) {
            try {
                await this.browser.close();
                this.browser = null;
                this.retryCount = 0;
                logger.info('浏览器已关闭');
            } catch (error: any) {
                logger.error('关闭浏览器失败:', error.message);
            }
        }
    }
}
