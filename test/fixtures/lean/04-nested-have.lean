/-
  Fixture 04 —— 嵌套 have（缩进栈）

  来源：openai/NavierStokesAndEuler 仓库，AnglePrimitiveKernel.lean 第 32–37 行
        （Apache-2.0）https://github.com/openai/NavierStokesAndEuler
  裁剪：为回归测试裁成最小片段；裁剪后**不保证可编译**。
  期望：内层 `have hp := …` 的 parent 是**紧邻的外层 have hzero**，不是 root；depth=1。
-/

theorem fixture_nested_have (P : ℝ) (hP : P ≠ 0) (f : ℝ → E) (hf : Continuous f)
    (hper : Function.Periodic f P) (hmean : (∫ s in (0 : ℝ)..P, f s)=0) (θ : ℝ) : True := by
  let q := primitive P f
  have hqp : Function.Periodic q P := primitive_periodic P f hf hper hmean
  have hzero : (∫ s in (0 : ℝ)..P, q (θ+s))=0 := by
    rw [intervalIntegral.integral_comp_add_left]
    have hp := hqp.intervalIntegral_add_eq θ 0
    rw [zero_add] at hp
    rw [add_zero, hp]
    exact primitive_mean_zero P hP f hf
  trivial
