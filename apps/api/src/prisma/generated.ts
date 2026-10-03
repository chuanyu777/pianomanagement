/**
 * 全项目**唯一**直接引用 Prisma 生成产物的文件。
 *
 * Prisma 7 的新 generator 把 client 生成成 TypeScript 源码（在 src/generated/prisma），
 * 路径由 prisma/schema.prisma 的 generator.output 决定。
 * 其它文件一律从这里转出 —— 这样将来生成结构变了，只改这一个文件。
 *
 * client.ts 已经把 enums.js 一起转出了，所以这里只 star 它一次；
 * 再 star 一次 enums 会让同名导出变歧义而被静默丢掉。
 */
export * from '../generated/prisma/client.js';
