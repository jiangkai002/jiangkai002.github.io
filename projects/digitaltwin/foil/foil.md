---
title: 超轻量化二维BIM模型展示
data: 2026-5-6
tags: [数字孪生, 模型轻量化]
description: 针对 Revit 等 BIM 软件导出模型面数冗余、缺乏拓扑优化的问题，采用预渲染切片方案：在服务端对 BIM 模型进行多视角离线渲染，生成瓦片图集，再借助 OpenLayers 在浏览器端实现高性能加载与交互，在零人工减面的前提下显著降低前端渲染压力。
---

## 项目开发背景

与游戏行业不同，数字孪生项目很少配备专职建模师。展示模型大多直接来源于 Revit 或 SketchUp，这类 BIM 软件的导出模型面数极高，且缺乏针对实时渲染的拓扑优化。实的更现问题是，公司领导通常不会接受为此搭建一套完整的高低模处理流程——成本高、周期长，而项目交期往往就摆在那里。

在 Unreal Engine 项目里，这个问题还能靠 Nanite 硬扛。但当展示载体换成 Web 浏览器时，WebGL 的性能上限就远没那么宽裕了。面对一栋动辄数百万面的 BIM 建筑，实时渲染几乎无从下手。

这个项目的出发点就是：**在不触碰模型本身、不依赖人工减面的前提下，找到一条让 BIM 模型在 Web 端流畅展示的路。**

思路的转变来自地图：地图系统也要在浏览器里展示海量的地理数据，它的解法是预渲染切片——把数据离线渲染成瓦片图集，前端只负责按视野按需加载对应的图片。BIM 模型的展示需求和地图高度相似：视角固定在俯视方向，关注的是空间布局与设备分布，而不是自由的三维漫游。

沿着这个思路，方案逐渐清晰：**在服务端对 BIM 模型进行多视角、高分辨率的离线渲染，利用脚本切分瓦片图集，再借助 OpenLayers 在浏览器端实现高性能加载与交互。** 前端完全不接触原始三维数据，渲染压力从客户端转移到了一次性的服务端预处理，同时保留了楼层切换、设备点选、图标定位等核心业务交互能力。

<a href="http://kns--cnki--net--https.cnki.mdjsf.utuvpn.utuedu.com:9000/kcms2/article/abstract?v=5qKCSu-RHigH6BsxKLP7CAVqcaJ5ky_0eyu4np0ZHMqDOA1PPsK95Q78CYoojlf-qyJJH9MYYeicCjmuiP-AQn4XGbWBhrgZygojJRC8SCN1-NZ0w1RYzB3lgxYiJ7phnrupY_Yc_NT7_Le9jwjoa9BYLSBQBL5m0FmARg1hHcnD2q_9WUb4dQ==&uniplatform=NZKPT" target="_blank" rel="noopener" style="color:#2563eb;font-weight:700">论文链接</a>

<img src="./image/foil-article.png" alt="轻量化BIM模型的数据集成和模型交互方法研究" style="width:100%;border-radius:4px;">

## 项目展示

## 出图渲染

<img src="./image/history.png" alt="历史效果" style="width:100%;border-radius:4px;">

核心出图方法经过了三代的技术，从Unity到Bimface到现在的Unreal，前两者已经是历史，目前
由于业务逻辑展示模型是按照 **“楼层-系统-方向”**来展示不同的建筑模型、管线模型和设备模型，所以前置就是需要在渲染每一张图的时候将当前的对应模型加以显示并隐藏掉其余的模型，这部分可以通过不同图形引擎的脚本实现。

 输出的json格式如下：
```json
 {
    "type": "FeatureCollection",
    "PassRate": "总数：596,成功数量：596,失败数量：0,成功率：100%",
    "camPostion": [
        91.9562382974267,
        211.199053243684,
        153.5665040387687
    ],
    "camUp": [
        -0.41266446011203317,
        0.812045902957566,
        -0.41266147730346153
    ],
    "camRight": [
        -0.7071067811864888,
        -2.5973483524788232e-06,
        0.7071067811818357
    ],
    "camSize": 143.84092934573374,
    "features": [
        {
            "TestFeedback": "Succeeded",
            "TestElementId": "elementid-8846454",
            "type": "Feature",
            "id": "device-209",
            "properties": {
                "name": "PAU-03-01"
            },
            "geometry": {
                "type": "Polygon",
                "coordinates": [
                    []
                ]
            }
        },]
 }
 ```
 其中

- `type` 固定为 `FeatureCollection`，整体遵循 GeoJSON 的组织方式，方便前端直接按要素集合读取。
- `PassRate` 用来记录本次轮廓计算的成功率，主要用于离线生成阶段排查模型、设备或脚本异常。
- `camPostion`、`camUp`、`camRight`、`camSize` 保存当前渲染相机的信息。前端并不需要真实还原三维相机，但需要利用这些参数把模型空间中的轮廓点映射到二维图片坐标中。
- `features` 是真正的业务要素列表，每一个 `Feature` 对应一个设备、管线或构件。`properties` 保存业务字段，`geometry.coordinates` 保存该对象在当前视角下投影后的二维轮廓。

也就是说，每一次离线出图并不是只生成一张静态图片，而是同时生成一份与图片严格对齐的索引数据。图片负责展示，JSON 负责交互。前端点选设备时，实际命中的不是三维模型，而是这份二维轮廓数据；业务系统再通过 `id` 或 `TestElementId` 反查对应设备详情。

这一点是整个方案能成立的关键：**把三维问题提前压缩成二维问题**。三维模型只在服务端渲染阶段短暂参与计算，浏览器端最终面对的是瓦片图片、二维多边形和少量业务属性，因此加载速度和交互复杂度都能控制在 Web 项目可接受的范围内。

### unity:

unity的核心脚本包含以下几类：

- `PhotoManager/PhotoAllManager.cs`：拍摄基础设施，负责相机、Layer、角度切换和公共方法。
- `PhotoManager/PhotoGameObjectViewManager.cs`：CSV 模型管线，按楼层和机电系统批量出图，并生成完整设备轮廓。
- `PhotoManager/PhotoElementViewManager.cs`：运行时 Element 管线，按 ActiveElement 数据切换楼层和系统出图。
- `CorePhoto/TestRenderTexture.cs`：真正执行 8K 离屏截图。
- `CorePhoto/BoundInView.cs`：根据 Mesh 顶点计算当前视角下的取景范围。
- `CoreOutline/OutLineTool-DESKTOP.cs`：把 CSV 设备列表转换成轮廓 JSON。
- `CoreOutline/Mesh2DTask.cs`：Mesh 到二维轮廓点的核心算法。
- `CoreOutline/GEOFeatureCollectionP.cs`、`CoreOutline/GEOFeatureCollection.cs`：JSON 输出结构。

其中最关键的设计是：不要直接依赖 Unity Game 视图分辨率，也不要通过大量 `SetActive` 管理复杂模型的显隐，而是把“业务可见性”和“渲染可见性”分开。业务层先决定要拍哪些对象，渲染层统一通过 Layer 和相机 `cullingMask` 控制最终进图内容。

### unreal:

官方会更好

## 交互逻辑
