import express from 'express';
import cors from 'cors';
import path from 'path';
import { CodeiumRegistration } from './register';
import winston from 'winston';

const app = express();
const port = 30000;
const REGISTRATION_URL = 'https://codeium.com/account/register';

// 配置日志
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.Console()
    ]
});

// 配置 CORS
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

let registrationInstance: CodeiumRegistration | null = null;

// 预览邮箱列表
app.post('/api/preview', (req, res) => {
    const { baseEmail, startVersion, endVersion } = req.body;
    
    try {
        const emails: string[] = [];
        const [localPart, domain] = baseEmail.split('@');
        
        for (let version = startVersion; version <= endVersion; version++) {
            emails.push(`${localPart}${version}@${domain}`);
        }
        
        res.json({ success: true, emails });
    } catch (error) {
        res.status(400).json({ success: false, error: '生成预览失败' });
    }
});

// 注册路由
app.post('/api/register', async (req, res) => {
    const { emails, password } = req.body;

    if (!emails || !password || !Array.isArray(emails) || emails.length === 0) {
        return res.status(400).json({ 
            success: false, 
            error: '请提供有效的邮箱列表和密码' 
        });
    }

    try {
        // 如果已经有正在进行的注册，先停止它
        if (registrationInstance) {
            await registrationInstance.cleanup();
            registrationInstance = null;
        }

        registrationInstance = new CodeiumRegistration({
            emails,
            password,
            registrationUrl: REGISTRATION_URL
        });

        // 开始注册过程
        registrationInstance.registerAll().catch((error: any) => {
            const errorMessage = error.message || '未知错误';
            logger.error('注册过程发生错误:', errorMessage);
            registrationInstance = null;  // 发生错误时清除实例
        });

        res.json({ success: true });
    } catch (error: any) {
        const errorMessage = error.message || '未知错误';
        logger.error('启动注册过程失败:', errorMessage);
        res.status(500).json({ 
            success: false, 
            error: '启动注册过程失败' 
        });
    }
});

// 添加停止注册的接口
app.post('/stop', async (req, res) => {
    if (registrationInstance) {
        await registrationInstance.cleanup();
        registrationInstance = null;
        res.json({ success: true, message: '注册进程已停止' });
    } else {
        res.json({ success: true, message: '没有正在运行的注册进程' });
    }
});

app.listen(port, () => {
    console.log(`服务器运行在 http://localhost:${port}`);
});
