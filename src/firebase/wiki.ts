import { 
  collection, 
  doc, 
  getDoc, 
  getDocs, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  query, 
  where, 
  orderBy, 
  Timestamp,
  serverTimestamp,
  increment,
  limit,
  startAfter,
  FieldValue
} from 'firebase/firestore';
import { db } from './config';

// Wiki記事の型定義
export interface WikiArticle {
  id?: string;
  title: string;
  description: string;
  content: string;
  tags: string[];
  author: string;
  authorId: string;
  imageUrl?: string;
  imageId?: string;
  date: Timestamp | string;
  lastUpdated?: Timestamp;
  usefulCount: number;
  likeCount: number;
  deleteUrl?: string;
}

// コメントの型定義を修正
export interface WikiComment {
  id?: string;
  content: string;
  author: string | null;
  authorId: string | null;
  date: Timestamp | string | FieldValue;
  replyCount?: number;
  likeCount?: number;
}

// 返信コメントの型定義を追加
export interface WikiReply extends WikiComment {
  parentId: string;
}

// 記事コレクションへの参照
const articlesRef = collection(db, 'wikiArticles');

/**
 * 記事IDから記事データを取得する
 * @param id 記事ID
 * @returns 記事データ
 */
export async function getArticleById(id: string): Promise<WikiArticle | null> {
  try {
    const docRef = doc(db, 'wikiArticles', id);
    const docSnap = await getDoc(docRef);
    
    if (docSnap.exists()) {
      return { id: docSnap.id, ...docSnap.data() } as WikiArticle;
    }
    
    return null;
  } catch (error) {
    console.error('記事取得エラー:', error);
    throw error;
  }
}

/**
 * すべての記事を取得する
 * @param sortField ソートフィールド
 * @returns 記事一覧
 */
export async function getAllArticles(sortField: string = 'usefulCount'): Promise<WikiArticle[]> {
  try {
    const q = query(articlesRef, orderBy(sortField, 'desc'));
    const querySnapshot = await getDocs(q);
    
    return querySnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    })) as WikiArticle[];
  } catch (error) {
    console.error('記事一覧取得エラー:', error);
    throw error;
  }
}

/**
 * タグで記事をフィルタリングする
 * @param tags タグ配列
 * @returns フィルタリングされた記事一覧
 */
export async function getArticlesByTags(tags: string[]): Promise<WikiArticle[]> {
  try {
    if (!tags.length) return getAllArticles();
    
    // Firestoreは配列に対する「すべての要素を含む」クエリをサポートしていないため
    // 最初のタグでフィルタリングした後、クライアント側でさらにフィルタリング
    const q = query(articlesRef, where('tags', 'array-contains', tags[0]));
    const querySnapshot = await getDocs(q);
    
    const articles = querySnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    })) as WikiArticle[];
    
    // 残りのタグでフィルタリング
    if (tags.length > 1) {
      return articles.filter(article => 
        tags.every(tag => article.tags.includes(tag))
      );
    }
    
    return articles;
  } catch (error) {
    console.error('タグによる記事取得エラー:', error);
    throw error;
  }
}

/**
 * 新しい記事を追加する
 * @param article 記事データ
 * @returns 追加された記事のID
 */
export async function createArticle(article: Omit<WikiArticle, 'id'>): Promise<string> {
  try {
    const docRef = await addDoc(articlesRef, {
      ...article,
      date: article.date || serverTimestamp(),
      lastUpdated: serverTimestamp(),
      usefulCount: article.usefulCount || 0,
      likeCount: article.likeCount || 0
    });
    
    return docRef.id;
  } catch (error) {
    console.error('記事作成エラー:', error);
    throw error;
  }
}

/**
 * 記事を更新する
 * @param id 記事ID
 * @param updateData 更新内容
 */
export async function updateArticle(id: string, updateData: Partial<WikiArticle>): Promise<void> {
  try {
    const docRef = doc(db, 'wikiArticles', id);
    await updateDoc(docRef, {
      ...updateData,
      lastUpdated: serverTimestamp()
    });
  } catch (error) {
    console.error('記事更新エラー:', error);
    throw error;
  }
}

/**
 * 記事を削除する
 * @param id 記事ID
 */
export async function deleteArticle(id: string): Promise<void> {
  try {
    const docRef = doc(db, 'wikiArticles', id);
    await deleteDoc(docRef);
  } catch (error) {
    console.error('記事削除エラー:', error);
    throw error;
  }
}

/**
 * ユーザーが書いた記事を取得する
 * @param authorId 著者ID
 * @returns ユーザーの記事一覧
 */
export async function getUserArticles(authorId: string): Promise<WikiArticle[]> {
  try {
    // インデックスが必要なクエリ
    const q = query(
      collection(db, 'wikiArticles'),
      where('authorId', '==', authorId),
      orderBy('date', 'desc')
    );
    
    const querySnapshot = await getDocs(q);
    const articles: WikiArticle[] = [];
    
    querySnapshot.forEach((doc) => {
      articles.push({
        id: doc.id,
        ...doc.data()
      } as WikiArticle);
    });
    
    return articles;
  } catch (error) {
    console.error('ユーザー記事取得エラー:', error);
    
    // 開発環境では、インデックスエラーを特定してガイダンスを表示
    if (error instanceof Error && error.toString().includes('requires an index')) {
      console.warn(
        'Firestoreインデックスが必要です。以下のリンクからインデックスを作成してください:',
        'https://console.firebase.google.com/project/evasio-nova/firestore/indexes'
      );
    }
    
    return [];
  }
}

/**
 * 「使えた！」カウントを増やす
 * @param id 記事ID
 * @returns 更新後の記事データ
 */
export async function incrementUsefulCount(id: string): Promise<void> {
  try {
    const docRef = doc(db, 'wikiArticles', id);
    await updateDoc(docRef, {
      usefulCount: increment(1)
    });
  } catch (error) {
    console.error('「使えた！」カウント更新エラー:', error);
    throw error;
  }
}

/**
 * 「いいね」カウントを増やす
 * @param id 記事ID
 * @returns 更新後の記事データ
 */
export async function incrementLikeCount(id: string): Promise<void> {
  try {
    const docRef = doc(db, 'wikiArticles', id);
    await updateDoc(docRef, {
      likeCount: increment(1)
    });
  } catch (error) {
    console.error('「いいね」カウント更新エラー:', error);
    throw error;
  }
}

/**
 * 記事のコメントを取得する
 * @param articleId 記事ID
 * @param lastComment 前回の最後のコメント（ページネーション用）
 * @param itemsPerPage 1ページあたりのコメント数
 * @returns コメント一覧
 */
export async function getArticleComments(
  articleId: string, 
  lastComment: WikiComment | null = null, 
  itemsPerPage: number = 10
): Promise<WikiComment[]> {
  try {
    // 記事のサブコレクションとしてのコメントを取得
    const commentsRef = collection(db, 'wikiArticles', articleId, 'comments');
    
    let q = query(
      commentsRef,
      orderBy('date', 'desc'),
      limit(itemsPerPage)
    );
    
    // ページネーション: 前回の最後のコメント以降を取得
    if (lastComment) {
      q = query(
        commentsRef,
        orderBy('date', 'desc'),
        startAfter(lastComment.date),
        limit(itemsPerPage)
      );
    }
    
    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    })) as WikiComment[];
  } catch (error) {
    console.error('コメント取得エラー:', error);
    throw error;
  }
}

/**
 * コメントの返信を取得する
 * @param articleId 記事ID
 * @param commentId 親コメントID
 * @param lastReply 前回の最後の返信（ページネーション用）
 * @param itemsPerPage 1ページあたりの返信数
 * @returns 返信一覧
 */
export async function getCommentReplies(
  articleId: string,
  commentId: string, 
  lastReply: WikiReply | null = null, 
  itemsPerPage: number = 5
): Promise<WikiReply[]> {
  try {
    // コメントのサブコレクションとしての返信を取得
    const repliesRef = collection(db, 'wikiArticles', articleId, 'comments', commentId, 'replies');
    
    let q = query(
      repliesRef,
      orderBy('date', 'asc'),
      limit(itemsPerPage)
    );
    
    if (lastReply) {
      q = query(
        repliesRef,
        orderBy('date', 'asc'),
        startAfter(lastReply.date),
        limit(itemsPerPage)
      );
    }
    
    const querySnapshot = await getDocs(q);
    return querySnapshot.docs.map(doc => ({
      id: doc.id,
      parentId: commentId,
      ...doc.data()
    })) as WikiReply[];
  } catch (error) {
    console.error('返信取得エラー:', error);
    throw error;
  }
}

/**
 * 新しいコメントを追加する
 * @param articleId 記事ID
 * @param comment コメントデータ
 * @returns 追加されたコメントのID
 */
export async function addComment(
  articleId: string,
  comment: Omit<WikiComment, 'id'>
): Promise<string> {
  try {
    const commentsRef = collection(db, 'wikiArticles', articleId, 'comments');
    const docRef = await addDoc(commentsRef, {
      ...comment,
      date: serverTimestamp(),
      replyCount: 0,
      likeCount: 0
    });
    
    return docRef.id;
  } catch (error) {
    console.error('コメント追加エラー:', error);
    throw error;
  }
}

/**
 * 返信コメントを追加する
 * @param articleId 記事ID
 * @param commentId 親コメントID
 * @param reply 返信データ
 * @returns 追加された返信のID
 */
export async function addReply(
  articleId: string,
  commentId: string,
  reply: Omit<WikiReply, 'id' | 'parentId'>
): Promise<string> {
  try {
    // トランザクションを使用して、返信の追加と親コメントの返信数更新を一括処理
    const repliesRef = collection(db, 'wikiArticles', articleId, 'comments', commentId, 'replies');
    const commentRef = doc(db, 'wikiArticles', articleId, 'comments', commentId);
    
    const docRef = await addDoc(repliesRef, {
      ...reply,
      date: serverTimestamp(),
      likeCount: 0
    });
    
    // 親コメントの返信カウントを増やす
    await updateDoc(commentRef, {
      replyCount: increment(1)
    });
    
    return docRef.id;
  } catch (error) {
    console.error('返信追加エラー:', error);
    throw error;
  }
}

/**
 * コメントのいいねカウントを増やす
 * @param articleId 記事ID
 * @param commentId コメントID
 * @returns 更新処理のPromise
 */
export async function incrementCommentLikeCount(
  articleId: string,
  commentId: string
): Promise<void> {
  try {
    const commentRef = doc(db, 'wikiArticles', articleId, 'comments', commentId);
    await updateDoc(commentRef, {
      likeCount: increment(1)
    });
  } catch (error) {
    console.error('コメントいいね更新エラー:', error);
    throw error;
  }
}

/**
 * 返信のいいねカウントを増やす
 * @param articleId 記事ID
 * @param commentId 親コメントID
 * @param replyId 返信ID
 * @returns 更新処理のPromise
 */
export async function incrementReplyLikeCount(
  articleId: string,
  commentId: string,
  replyId: string
): Promise<void> {
  try {
    const replyRef = doc(db, 'wikiArticles', articleId, 'comments', commentId, 'replies', replyId);
    await updateDoc(replyRef, {
      likeCount: increment(1)
    });
  } catch (error) {
    console.error('返信いいね更新エラー:', error);
    throw error;
  }
}
