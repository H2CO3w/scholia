/-
  Fixture 05 —— 聚焦子弹后的 have（`· have …`，Mathlib 常见写法）

  来源：openai/NavierStokesAndEuler 仓库，BaseEulerSign.lean 第 69–79 行
        （Apache-2.0）https://github.com/openai/NavierStokesAndEuler
  裁剪：为回归测试裁成最小片段（证明体控制在 490 字符以内，避免触发数据集截断标记）；
        have 行保留原文；裁剪后**不保证可编译**。
  期望：子弹同行/紧跟其后的 have 都要建节点；`·` 只改缩进层次，不改声明本身。
        本例真值 3 个 have：hh（子弹同行）、hr（子弹同行、值用 by）、hh（嵌套在 hr 的 by 里）。
-/

theorem fixture_bullet_have (T : ℝ) (hT : 0 < T) (G : Guards) (L : Data)
    (hguard : T ≤ guardTime G.T L.K) : True := by
  apply source_numerator_pos L m hm R S hS ξ hξ x _ _ t
  · have hh := (mul_le_mul_of_nonneg_left hguard (coefficientCost_nonneg L.K)).trans
      (guardTime_small G.T L.K).1
    exact hh.trans (by norm_num)
  · have hr : 0 ≤ firstSignRate (coefficientCost L.K) (coefficientCost L.K) := by
      unfold firstSignRate
      positivity [coefficientCost_nonneg L.K]
    have hh := (mul_le_mul_of_nonneg_left hguard hr).trans (guardTime_small G.T L.K).2
    exact hh.trans (by norm_num)
