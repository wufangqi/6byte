# Markdown 预览与导出一致性样例

[跳到代码](#代码) · [跳到图表](#图表)

## 代码

```typescript
const greeting = "<hello>";
console.log(greeting);
```

## 公式

行内公式：$E=mc^2$。

$$
\int_0^1 x^2 dx = \frac{1}{3}
$$

## 图表

```mermaid
flowchart LR
  Draft --> Preview
  Preview --> Export
```

## 本地图片

![欢迎页](../../../docs/assets/welcome.png)
